#!/usr/bin/env node
// `strata-coder init` orchestrator.
//
// Collects the model endpoint, model id, optional credential variable name and
// a real check command for one project, writes the project configuration plus
// the managed documentation blocks, and finally verifies that the generated MCP
// server can be started and exposes the five tools.
//
// Only the files it manages are touched; existing content outside the managed
// blocks is preserved, user-modified rule files are never overwritten, and
// nothing is ever deleted.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { validateConfig } from './config.js';
import { prepareInitRuntime } from './init-runtime.js';

import {
  splitCommandLine,
  isPlaceholderTestScript,
  detectNpmCheck,
  buildProjectConfig,
  validateBaseUrl,
  buildServerCommand,
  buildGenericStdioConfig,
  renderCollaborationRules,
  renderAgentsReference,
  renderGitignoreBlock,
} from './init-plan.js';
import {
  hashContent,
  atomicWriteFile,
  backupFile,
  upsertManagedBlock,
  managedFileAction,
} from './project-files.js';
import {
  parseOpenCodeVersion,
  upsertStrataCoderConfig,
  readProjectConfig,
} from './opencode-config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const templatePath = fileURLToPath(new URL('../prompts/project-collaboration.md', import.meta.url));

const CHECK_NAME = 'strata_unit';
const CHECK_TIMEOUT_SECONDS = 300;
const DEFAULT_API_KEY_ENV = 'LOCAL_CODER_API_KEY';
const MODELS_TIMEOUT_MS = 5000;
const MAX_MODEL_PROMPTS = 3;
const MAX_LISTED_MODELS = 20;
const EXPECTED_TOOLS = ['cancel_task', 'get_capabilities', 'get_task', 'read_artifact', 'submit_task'];

const OPTIONS = {
  cwd: { type: 'string' },
  baseUrl: { type: 'string' },
  model: { type: 'string' },
  apiKeyEnv: { type: 'string' },
  'check-command': { type: 'string' },
  yes: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function printHelp(stdout) {
  stdout.write('usage: strata-coder init [options]\n\n');
  stdout.write('  --cwd <dir>            项目目录（默认当前目录）\n');
  stdout.write('  --baseUrl <url>        模型 API 地址，例如 http://127.0.0.1:8080/v1\n');
  stdout.write('  --model <id>           模型 ID\n');
  stdout.write('  --apiKeyEnv <name>     存放密钥的环境变量名；留空表示不鉴权\n');
  stdout.write('  --check-command <line> 检查命令（不经过 shell，按 argv 拆分）\n');
  stdout.write('  --yes                  非交互模式，不提问\n');
  stdout.write('  -h, --help             显示本帮助\n\n');
  stdout.write('未传 --yes 时，TTY 下会进入引导式提问；非交互使用必须传 --baseUrl 和 --model。\n');
}

function readCandidateConfig(projectRoot, env, warn) {
  const candidates = [
    path.join(projectRoot, '.strata-coder', 'config.json'),
    env.STRATA_CODER_CONFIG,
    env.LOCAL_CODER_CONFIG,
    path.join(projectRoot, 'strata-coder.config.json'),
    path.join(projectRoot, 'local-coder.config.json'),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (error) {
      warn(`忽略无法解析的候选配置：${candidate}（${error.message}）`);
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warn(`忽略非对象的候选配置：${candidate}`);
      continue;
    }

    // Only connection-related fields are reused as defaults; the generated
    // config never stores directory whitelists.
    return { path: candidate, values: raw };
  }

  return null;
}

async function fetchModelIds(baseUrl, apiKeyEnv, env) {
  const headers = {};
  if (apiKeyEnv && env[apiKeyEnv]) headers.Authorization = `Bearer ${env[apiKeyEnv]}`;

  const response = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());

  const body = await response.json();
  const raw = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(raw)) throw new Error('响应中没有模型列表数组');

  const ids = raw
    .map(item => (typeof item === 'string' ? item : item?.id))
    .filter(id => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) throw new Error('模型列表为空');
  return ids;
}

async function resolveModelInteractively(rl, baseUrl, apiKeyEnv, env, candidateModel, warn) {
  if (candidateModel) {
    const answer = (await rl.question(`模型 ID [默认 ${candidateModel}]：`)).trim();
    return answer || candidateModel;
  }

  let ids = null;
  try {
    ids = await fetchModelIds(baseUrl, apiKeyEnv, env);
  } catch (error) {
    warn(`无法读取模型列表：${error.message}，请手动输入模型 ID。`);
  }

  for (let attempt = 0; attempt < MAX_MODEL_PROMPTS; attempt += 1) {
    if (ids) {
      const shown = ids.slice(0, MAX_LISTED_MODELS);
      stdoutLines(shown.map((id, index) => `  ${index + 1}. ${id}`));
      const answer = (await rl.question(`选择编号或输入模型 ID：`)).trim();
      if (!answer) continue;
      const picked = /^\d+$/.test(answer) ? shown[Number(answer) - 1] : answer;
      if (picked) return picked;
      warn('输入无法匹配模型列表，请重试。');
      continue;
    }
    const answer = (await rl.question('模型 ID：')).trim();
    if (answer) return answer;
    warn('模型 ID 不能为空。');
  }

  return null;
}

// Small indirection so the plan printing and warnings can be tested through the
// provided streams without depending on the caller's stream names.
let writeLine = () => {};

function stdoutLines(lines) {
  for (const line of lines) writeLine(line);
}

export async function runInit(argv, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
  } catch (error) {
    stderr.write(`参数错误：${error.message}\nRun "strata-coder init --help"\n`);
    return 1;
  }

  if (values.help) {
    printHelp(stdout);
    return 0;
  }

  writeLine = line => stdout.write(`${line}\n`);
  const warn = line => stderr.write(`警告：${line}\n`);

  // 1. Project root.
  let projectRoot;
  try {
    projectRoot = fs.realpathSync(path.resolve(values.cwd || cwd));
  } catch (error) {
    stderr.write(`错误：无法解析项目目录：${error.message}\n`);
    return 1;
  }
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    stderr.write(`错误：项目目录不存在或不是目录：${projectRoot}\n`);
    return 1;
  }

  // 2. Environment checks.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    stderr.write(`错误：需要 Node.js 22 或更高版本，当前为 ${process.versions.node}。\n`);
    return 1;
  }

  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    warn('未找到可用的 git，快照将回退为目录遍历。');
  }

  // 3. Candidate config.
  const existingPath = path.join(projectRoot, '.strata-coder', 'config.json');
  let existing = {};
  if (fs.existsSync(existingPath)) {
    existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new Error('Existing project config must be a JSON object; refusing to overwrite it.');
    }
  }
  const candidate = readCandidateConfig(projectRoot, env, warn);
  if (candidate) writeLine(`读取已有配置作为候选：${candidate.path}`);

  const interactive = !values.yes && stdin.isTTY && stdout.isTTY;

  // 4. baseUrl.
  let baseUrlRaw = values.baseUrl || candidate?.values?.baseUrl || null;
  let rl = null;
  let incomplete = false;

  try {
    if (!baseUrlRaw && interactive) {
      rl = readline.createInterface({ input: stdin, output: stdout });
      const answer = (await rl.question(
        `模型地址${candidate?.values?.baseUrl ? ` [默认 ${candidate.values.baseUrl}]` : ''}：`
      )).trim();
      baseUrlRaw = answer || candidate?.values?.baseUrl || null;
    }
    if (!baseUrlRaw) {
      stderr.write('错误：缺少模型地址：请传 --baseUrl（或运行 strata-coder init --help 查看用法）。\n');
      return 1;
    }

    let baseUrl;
    try {
      baseUrl = validateBaseUrl(baseUrlRaw);
    } catch (error) {
      stderr.write(`错误：${error.message}\n`);
      return 1;
    }

    // 5. model.
    let model = values.model || candidate?.values?.model || null;
    if (!model && interactive) {
      if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
      model = await resolveModelInteractively(rl, baseUrl, candidate?.values?.apiKeyEnv || '', env, null, warn);
    }
    if (!model) {
      stderr.write('错误：缺少模型 ID：请传 --model（或运行 strata-coder init --help 查看用法）。\n');
      return 1;
    }

    // 6. apiKeyEnv. Never read or print the secret value itself.
    let apiKeyEnv = '';
    if (values.apiKeyEnv !== undefined) {
      apiKeyEnv = values.apiKeyEnv;
    } else if (candidate?.values?.apiKeyEnv) {
      apiKeyEnv = String(candidate.values.apiKeyEnv);
    } else if (interactive) {
      if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
      const needs = (await rl.question('模型需要鉴权吗？(y/N)：')).trim().toLowerCase();
      if (needs === 'y' || needs === 'yes') {
        apiKeyEnv = (await rl.question(`环境变量名 [默认 ${DEFAULT_API_KEY_ENV}]：`)).trim() || DEFAULT_API_KEY_ENV;
      }
    }

    let mcpEntry = path.join(packageRoot, 'src', 'mcp.js');
    let helperPath = path.join(packageRoot, 'src', 'npm-check.js');

    // 7. Check detection.
    let check = null;
    let packageJson = null;
    const packageJsonPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      } catch (error) {
        warn(`无法解析 package.json：${error.message}`);
      }
    }

    // Explicit input wins; otherwise keep the project's existing checks.
    let updateCheck = null;
    if (values['check-command'] !== undefined) {
      let command;
      try { command = splitCommandLine(values['check-command']); }
      catch (error) { throw new Error(`--check-command 无法解析：${error.message}`); }
      if (!command[0] || isPlaceholderTestScript(values['check-command'])) {
        throw new Error('--check-command must name a real, non-empty check.');
      }
      updateCheck = { name: CHECK_NAME, command, timeoutSeconds: CHECK_TIMEOUT_SECONDS };
    } else if (!Object.keys(existing.checks ?? {}).length) {
      const detected = detectNpmCheck({ projectRoot, packageJson, helperPath, nodePath: process.execPath });
      if (detected.detected) {
        updateCheck = detected;
        writeLine(`检测到项目检查：${detected.script}`);
      } else if (interactive) {
        if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
        writeLine(`未检测到可用检查：${detected.reason}。`);
        const line = (await rl.question('检查命令（可留空，不经过 shell）：')).trim();
        if (line) {
          const command = splitCommandLine(line);
          if (!command[0] || isPlaceholderTestScript(line)) throw new Error('检查命令为空或是占位脚本。');
          updateCheck = { name: CHECK_NAME, command, timeoutSeconds: CHECK_TIMEOUT_SECONDS };
        }
      }
    }

    // 8. Desired artifacts.
    const stateDir = path.join(projectRoot, '.strata-coder');
    const configPath = path.join(stateDir, 'config.json');
    const backupDir = path.join(stateDir, 'backups');
    const statePath = path.join(stateDir, 'init-state.json');
    const rulesPath = path.join(projectRoot, '.opencode', 'strata-coder.md');
    const gitignorePath = path.join(projectRoot, '.gitignore');
    const agentsPath = path.join(projectRoot, 'AGENTS.md');

    let template;
    try {
      template = await fsp.readFile(templatePath, 'utf8');
    } catch (error) {
      stderr.write(`错误：无法读取协作规则模板：${error.message}\n`);
      return 1;
    }

    const desiredConfig = buildProjectConfig({ baseUrl, model, apiKeyEnv, check: updateCheck, existing });
    validateConfig(desiredConfig); // Validate before changing any user configuration.
    const checkName = desiredConfig.defaultChecks[0] || Object.keys(desiredConfig.checks)[0];
    check = checkName ? { name: checkName, ...desiredConfig.checks[checkName] } : null;
    // Validate user settings first; only then materialize a stable npx runtime.
    if (packageRoot.split(/[\\/]/).includes('_npx')) {
      writeLine('准备项目内的稳定运行版本（不依赖 npx 缓存）');
      const runtimeRoot = await prepareInitRuntime(packageRoot, projectRoot);
      mcpEntry = path.join(runtimeRoot, 'src', 'mcp.js');
      const stableHelper = path.join(runtimeRoot, 'src', 'npm-check.js');
      if (updateCheck?.detected) {
        desiredConfig.checks[updateCheck.name].command = [process.execPath, stableHelper, '--', 'npm', 'test'];
      }
    }
    const desiredConfigText = `${JSON.stringify(desiredConfig, null, 2)}\n`;
    const desiredRules = renderCollaborationRules(template, {
      projectRoot,
      configPath,
      checkName: check?.name ?? '',
      collaborationRules: await fsp.readFile(new URL('../prompts/planner.md', import.meta.url), 'utf8'),
    });

    const recorded = readInitState(statePath);
    const rulesDecision = managedFileAction({
      existingText: readTextIfExists(rulesPath),
      desiredText: desiredRules,
      recordedHash: recorded['.opencode/strata-coder.md'],
    });

    const gitignoreExisting = readTextIfExists(gitignorePath);
    const gitignoreResult = upsertManagedBlock(gitignoreExisting ?? '', {
      start: '# strata-coder:start',
      end: '# strata-coder:end',
      block: renderGitignoreBlock(),
    });
    if (gitignoreResult.error) warn(`.gitignore 标记不配对，未修改 ${gitignorePath}`);

    const agentsExisting = readTextIfExists(agentsPath);
    const agentsResult = upsertManagedBlock(agentsExisting ?? '', {
      start: '<!-- strata-coder:start -->',
      end: '<!-- strata-coder:end -->',
      block: renderAgentsReference(),
    });
    if (agentsResult.error) warn(`AGENTS.md 标记不配对，未修改 ${agentsPath}`);

    const serverCommand = buildServerCommand({ nodePath: process.execPath, mcpEntry, configPath });
    const opencode = readProjectConfig(projectRoot);
    const opencodeExisting = opencode.exists ? readTextIfExists(opencode.path) : '';
    const opencodeResult = upsertStrataCoderConfig(opencodeExisting ?? '', { command: serverCommand });
    const opencodeMajor = opencodeVersion(projectRoot, env);
    const opencodeWillWrite = opencodeMajor === 2 && !opencodeResult.conflict && opencodeResult.changed;
    if (opencodeResult.conflict) {
      warn(`检测到同名服务指向其他程序，未修改 ${opencode.path}`);
      incomplete = true;
    } else if (opencodeMajor !== 2) {
      warn(`OpenCode 版本不可确认或不是 2.x（${opencodeMajor ?? '未知'}），未修改 ${opencode.path}`);
    }

    const configAction = actionLabel(configPath, desiredConfigText);
    const targets = [
      { path: configPath, action: configAction, mode: 0o600, text: desiredConfigText, changed: configAction !== 'keep' },
      { path: gitignorePath, action: blockLabel(gitignorePath, gitignoreResult), mode: 0o644, text: gitignoreResult.text, changed: gitignoreResult.changed && !gitignoreResult.error },
      { path: agentsPath, action: blockLabel(agentsPath, agentsResult), mode: 0o644, text: agentsResult.text, changed: agentsResult.changed && !agentsResult.error },
      { path: rulesPath, action: rulesDecision.action === 'skip-modified' ? 'keep' : rulesDecision.action, mode: 0o644, text: rulesDecision.text, changed: rulesDecision.action === 'create' || rulesDecision.action === 'update' },
      { path: opencode.path, action: opencodeWillWrite ? actionLabel(opencode.path, opencodeResult.text) : 'keep', mode: 0o644, text: opencodeResult.text, changed: opencodeWillWrite },
    ];

    // 10. Plan, then write.
    writeLine('计划：');
    for (const target of targets) writeLine(`  [${target.action}] ${target.path}`);

    const written = [];
    for (const target of targets) {
      if (!target.changed) {
        written.push({ path: target.path, action: target.action });
        continue;
      }
      const backup = await backupFile(target.path, backupDir);
      await atomicWriteFile(target.path, target.text, target.mode);
      written.push({ path: target.path, action: target.action, backup });
    }

    if (rulesDecision.action === 'skip-modified') {
      warn(`保留了用户修改过的规则文件：${rulesPath}`);
    }

    const newState = { version: 1, managed: { ...recorded } };
    if (rulesDecision.action === 'create' || rulesDecision.action === 'update') {
      newState.managed['.opencode/strata-coder.md'] = hashContent(desiredRules);
    }
    const desiredStateText = `${JSON.stringify(newState, null, 2)}\n`;
    if (readTextIfExists(statePath) !== desiredStateText) {
      await atomicWriteFile(statePath, desiredStateText, 0o600);
    }

    // 11. Self-verification through the generated server command.
    incomplete = (await verifyServer(serverCommand, configPath, projectRoot, check, warn)) || incomplete;

    // 12. Summary.
    writeLine('结果：');
    for (const item of written) {
      const label = item.action === 'create' ? '创建' : item.action === 'update' ? '更新' : '保留';
      writeLine(`  ${label}：${item.path}${item.backup ? `（备份：${item.backup}）` : ''}`);
    }

    writeLine('通用 stdio 配置：');
    writeLine(JSON.stringify(buildGenericStdioConfig({ serverCommand }), null, 2));

    writeLine('下一步：');
    writeLine(`  在项目目录 ${projectRoot} 中启动 OpenCode，或把上面的通用配置粘贴到其他 MCP 客户端。`);
    writeLine('移除：删除 .opencode/strata-coder.md、AGENTS.md 中 strata-coder:start 与 strata-coder:end 之间的引用，并移除 OpenCode 配置中的 strata_coder 服务。');

    if (!check) {
      writeLine('尚不能提交编码任务：未配置有效检查');
      incomplete = true;
    }

    return incomplete ? 1 : 0;
  } finally {
    if (rl) rl.close();
  }
}

function actionLabel(targetPath, desiredText) {
  if (!fs.existsSync(targetPath)) return 'create';
  return readTextIfExists(targetPath) === desiredText ? 'keep' : 'update';
}

function blockLabel(targetPath, result) {
  if (!fs.existsSync(targetPath)) return 'create';
  return result.changed ? 'update' : 'keep';
}

function readTextIfExists(targetPath) {
  try {
    return fs.readFileSync(targetPath, 'utf8');
  } catch {
    return undefined;
  }
}

function readInitState(statePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (raw && typeof raw === 'object' && raw.managed && typeof raw.managed === 'object') return { ...raw.managed };
  } catch {
    // A missing or unreadable state file simply means nothing was recorded.
  }
  return {};
}

function opencodeVersion(projectRoot, env) {
  const probe = spawnSync('opencode', ['--version'], { cwd: projectRoot, encoding: 'utf8', env });
  if (probe.error || probe.status !== 0) return null;
  return parseOpenCodeVersion(String(probe.stdout ?? ''));
}

async function verifyServer(serverCommand, configPath, projectRoot, check, warn) {
  const client = new Client({ name: 'strata-coder-init', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: serverCommand[0],
    args: serverCommand.slice(1),
    stderr: 'pipe',
    // The verification client does not advertise MCP roots, so the server
    // inherits the startup directory; spawn it in the initialized project.
    cwd: projectRoot,
  });

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const names = (listed.tools || []).map(tool => tool.name).sort();
    const missing = EXPECTED_TOOLS.filter(name => !names.includes(name));
    if (missing.length > 0) {
      warn(`MCP 握手缺少工具：${missing.join(', ')}`);
      return true;
    }

    const result = await client.callTool({ name: 'get_capabilities' });
    const text = result?.content?.find(item => item?.type === 'text')?.text;
    const capabilities = JSON.parse(text || '{}');
    const roots = Array.isArray(capabilities.workspace?.roots) ? capabilities.workspace.roots : [];
    if (!roots.includes(projectRoot)) {
      warn(`get_capabilities 的 workspace 目录不包含 ${projectRoot}`);
      return true;
    }
    if (check && !(Array.isArray(capabilities.checks) && capabilities.checks.includes(check.name))) {
      warn(`get_capabilities 的 checks 不包含 ${check.name}`);
      return true;
    }
    return false;
  } catch (error) {
    warn(`自检失败：${error.message}`);
    return true;
  } finally {
    await client.close().catch(() => {});
  }
}

// Direct-run guard: `node src/init.js ...` behaves like the CLI, while importing
// `runInit` from another module never triggers it.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  runInit(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      process.stderr.write(`错误：${error.message}\n`);
      process.exitCode = 1;
    });
}

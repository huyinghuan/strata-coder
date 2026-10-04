import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  countOccurrences,
  initPath,
  listFiles,
  makeFakeOpenCode,
  makeProject,
  readJson,
  readTextIfExists,
  repoRoot,
  runInit,
  snapshotHashes,
} from './init-helpers.js';

const EXPECTED_TOOLS = ['cancel_task', 'get_capabilities', 'get_task', 'read_artifact', 'submit_task'];

function isCompleteServer(server, configPath) {
  assert.ok(server, 'strata_coder server object is missing');
  assert.equal(server.type, 'local');
  assert.equal(server.codemode, false);
  assert.ok(Array.isArray(server.command), 'server.command must be an argv array');
  assert.ok(server.command.includes(path.join(repoRoot, 'src', 'mcp.js')));
  assert.ok(server.command.includes(configPath));
}

test('init --help exits 0 and prints usage', async t => {
  const project = await makeProject(t);
  const result = await runInit({ project: project.root, args: ['--help'] });

  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /strata-coder init/);
  assert.match(result.stdout, /--baseUrl/);
});

test('happy path writes config, managed blocks and OpenCode server for a path with Chinese characters and a space', async t => {
  const bin = await makeFakeOpenCode(t);
  const project = await makeProject(t, { name: '项目 目录' });
  const realRoot = await fsp.realpath(project.root);

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model', '--apiKeyEnv', 'INIT_KEY'],
    opencodeBin: bin,
  });
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const configPath = path.join(realRoot, '.strata-coder', 'config.json');
  const config = await readJson(configPath);
  assert.equal('workspaceRoots' in config, false);
  assert.equal(config.stateDir, 'state');
  assert.equal(config.requireChecks, true);
  assert.ok(Array.isArray(config.checks.strata_unit.command));
  assert.ok(config.checks.strata_unit.command.includes('npm'));
  assert.ok(config.checks.strata_unit.command.includes('test'));
  assert.ok(config.checks.strata_unit.command.some(entry => String(entry).endsWith('npm-check.js')));
  assert.deepEqual(config.defaultChecks, ['strata_unit']);
  assert.equal(config.apiKeyEnv, 'INIT_KEY');
  assert.equal(config.reasoningEffort, 'low');
  assert.equal(config.maxOutputTokens, 13000);

  const gitignore = readTextIfExists(path.join(realRoot, '.gitignore'));
  assert.ok(gitignore, '.gitignore was not created');
  assert.equal(countOccurrences(gitignore, '# strata-coder:start'), 1);
  assert.equal(countOccurrences(gitignore, '# strata-coder:end'), 1);

  const agents = readTextIfExists(path.join(realRoot, 'AGENTS.md'));
  assert.ok(agents, 'AGENTS.md was not created');
  assert.equal(countOccurrences(agents, '<!-- strata-coder:start -->'), 1);
  assert.equal(countOccurrences(agents, '<!-- strata-coder:end -->'), 1);
  assert.match(agents, /\.opencode\/strata-coder\.md/);

  const rules = readTextIfExists(path.join(realRoot, '.opencode', 'strata-coder.md'));
  assert.ok(rules, '.opencode/strata-coder.md was not created');
  assert.ok(rules.includes(realRoot), `rules file must reference the project path:\n${rules}`);
  assert.ok(rules.includes('strata_unit'));
  assert.ok(!rules.includes('{{'), `unresolved placeholder left in rules file:\n${rules}`);

  const opencodeJson = await readJson(path.join(realRoot, '.opencode', 'opencode.json'));
  isCompleteServer(opencodeJson.mcp?.servers?.strata_coder, configPath);
});

test('the generated config passes a real MCP handshake with the five tools', async t => {
  const bin = await makeFakeOpenCode(t);
  const project = await makeProject(t);
  const realRoot = await fsp.realpath(project.root);

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'],
    opencodeBin: bin,
  });
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const configPath = path.join(realRoot, '.strata-coder', 'config.json');
  const client = new Client({ name: 'init-handshake-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'src', 'mcp.js'), '--config', configPath],
    cwd: realRoot,
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const names = (listed.tools || []).map(tool => tool.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort());

    const call = await client.callTool({ name: 'get_capabilities' });
    const text = call?.content?.find(item => item?.type === 'text')?.text;
    const capabilities = JSON.parse(text || '{}');
    assert.ok(Array.isArray(capabilities.workspace.roots));
    assert.ok(capabilities.workspace.roots.includes(realRoot), `workspace: ${JSON.stringify(capabilities.workspace)}`);
    assert.equal(capabilities.workspace.source, 'cwd');
    assert.ok(Array.isArray(capabilities.checks));
    assert.ok(capabilities.checks.includes('strata_unit'), `checks: ${JSON.stringify(capabilities.checks)}`);
  } finally {
    await client.close();
  }
});

test('repeat runs are byte-identical, keep one managed block and create no backups', async t => {
  const bin = await makeFakeOpenCode(t);
  const project = await makeProject(t);
  const args = ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'];

  const first = await runInit({ project: project.root, args, opencodeBin: bin });
  assert.equal(first.code, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);

  const before = await snapshotHashes(project.root);
  const second = await runInit({ project: project.root, args, opencodeBin: bin });
  assert.equal(second.code, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);

  const after = await snapshotHashes(project.root);
  assert.deepEqual(after, before);

  const gitignore = readTextIfExists(path.join(project.root, '.gitignore')) ?? '';
  assert.equal(countOccurrences(gitignore, '# strata-coder:start'), 1);
  const agents = readTextIfExists(path.join(project.root, 'AGENTS.md')) ?? '';
  assert.equal(countOccurrences(agents, '<!-- strata-coder:start -->'), 1);

  const backups = path.join(project.root, '.strata-coder', 'backups');
  const entries = await fsp.readdir(backups).catch(() => null);
  assert.ok(entries === null || entries.length === 0, `unexpected backups: ${JSON.stringify(entries)}`);
});

test('JSONC comments, model, provider and unrelated MCP servers are preserved', async t => {
  const bin = await makeFakeOpenCode(t);
  const project = await makeProject(t);

  const jsoncPath = path.join(project.root, '.opencode', 'opencode.jsonc');
  await fsp.mkdir(path.dirname(jsoncPath), { recursive: true });
  const original = {
    model: 'anthropic/x',
    provider: { anthropic: { options: { baseURL: 'https://api.anthropic.com' } } },
    mcp: { servers: { other: { type: 'local', command: ['echo', 'other'] } } },
  };
  await fsp.writeFile(
    jsoncPath,
    `{
  // keep me
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/x",
  "provider": {
    "anthropic": { "options": { "baseURL": "https://api.anthropic.com" } }
  },
  "mcp": {
    "servers": {
      "other": { "type": "local", "command": ["echo", "other"] }
    }
  }
}
`,
  );

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'],
    opencodeBin: bin,
  });
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const text = readTextIfExists(jsoncPath);
  assert.ok(text, 'opencode.jsonc disappeared');
  assert.ok(text.includes('// keep me'), `comment lost:\n${text}`);

  const parsed = await readJson(jsoncPath);
  assert.equal(parsed.model, original.model);
  assert.deepEqual(parsed.provider, original.provider);
  assert.deepEqual(parsed.mcp.servers.other, original.mcp.servers.other);
  const realRoot = await fsp.realpath(project.root);
  isCompleteServer(parsed.mcp?.servers?.strata_coder, path.join(realRoot, '.strata-coder', 'config.json'));
});

test('secret values never appear in generated files', async t => {
  const bin = await makeFakeOpenCode(t);
  const project = await makeProject(t);
  const secret = 'SUPERSECRET0123456789';

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model', '--apiKeyEnv', 'INIT_SECRET'],
    env: { INIT_SECRET: secret },
    opencodeBin: bin,
  });
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(!result.stdout.includes(secret), `stdout leaked the secret:\n${result.stdout}`);
  assert.ok(!result.stderr.includes(secret), `stderr leaked the secret:\n${result.stderr}`);

  const files = await listFiles(project.root);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(!file.text.includes(secret), `secret found in ${file.path}`);
  }

  const config = await readJson(path.join(project.root, '.strata-coder', 'config.json'));
  assert.equal(config.apiKeyEnv, 'INIT_SECRET');
});

test('a project without a test script and without --check-command exits non-zero', async t => {
  const project = await makeProject(t, { packageJson: { name: 'demo', version: '1.0.0' } });

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'],
  });
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(combined.includes('尚不能提交编码任务'), combined);

  const config = await readJson(path.join(project.root, '.strata-coder', 'config.json'));
  assert.deepEqual(config.checks, {});
  assert.deepEqual(config.defaultChecks, []);
});

test('non-interactive init without --baseUrl fails before writing any config', async t => {
  const project = await makeProject(t);

  const result = await runInit({ project: project.root, args: ['--model', 'smoke-model'] });
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const configPath = path.join(project.root, '.strata-coder', 'config.json');
  assert.equal(readTextIfExists(configPath), undefined, `config must not be written:\n${result.stdout}\n${result.stderr}`);

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(combined.includes('--baseUrl'), `output must mention --baseUrl:\n${combined}`);
});

test('non-interactive init without --model fails before writing any config', async t => {
  const project = await makeProject(t);

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1'],
  });
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const configPath = path.join(project.root, '.strata-coder', 'config.json');
  assert.equal(readTextIfExists(configPath), undefined, `config must not be written:\n${result.stdout}\n${result.stderr}`);

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(combined.includes('--model'), `output must mention --model:\n${combined}`);
});

test('an invalid --baseUrl fails before writing any config', async t => {
  const project = await makeProject(t);

  const result = await runInit({ project: project.root, args: ['--baseUrl', 'not-a-url', '--model', 'smoke-model'] });
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const configPath = path.join(project.root, '.strata-coder', 'config.json');
  assert.equal(readTextIfExists(configPath), undefined, `config must not be written:\n${result.stdout}\n${result.stderr}`);

  const files = await listFiles(project.root);
  const stateFiles = files.filter(file => file.path.startsWith('.strata-coder/'));
  assert.deepEqual(stateFiles, [], `no .strata-coder content may be created:\n${result.stdout}\n${result.stderr}`);

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(/baseurl/i.test(combined), `output must mention baseUrl:\n${combined}`);
});

test('a non-existent --cwd fails without creating the directory', async t => {
  const missing = path.join(os.tmpdir(), `strata-init-missing-cwd-${process.pid}-${Date.now()}`);
  assert.equal(await fsp.stat(missing).catch(() => null), null, `test path must not exist: ${missing}`);

  const result = await runInit({
    project: missing,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'],
  });
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  assert.equal(await fsp.stat(missing).catch(() => null), null, `no directory may be created at ${missing}`);
});

test('an unterminated quote in --check-command fails before writing any config', async t => {
  const project = await makeProject(t, { packageJson: { name: 'demo', version: '1.0.0' } });

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model', '--check-command', 'node --test "unterminated'],
  });
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const configPath = path.join(project.root, '.strata-coder', 'config.json');
  assert.equal(readTextIfExists(configPath), undefined, `config must not be written:\n${result.stdout}\n${result.stderr}`);

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(
    combined.includes('--check-command') || combined.includes('无法解析'),
    `output must report the unparsable command:\n${combined}`,
  );
});

test('a placeholder test script saves an empty-check config and reports no coding task', async t => {
  const project = await makeProject(t, { testScript: 'echo "Error: no test specified" && exit 1' });

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'],
  });
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const configPath = path.join(project.root, '.strata-coder', 'config.json');
  const text = readTextIfExists(configPath);
  assert.ok(text, `config must still be written:\n${result.stdout}\n${result.stderr}`);

  const config = await readJson(configPath);
  assert.deepEqual(config.checks, {});
  assert.deepEqual(config.defaultChecks, []);

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(combined.includes('尚不能提交编码任务'), combined);
});

test('a same-name OpenCode server pointing elsewhere is never overwritten', async t => {
  const bin = await makeFakeOpenCode(t, 'opencode v2.0.22');
  const project = await makeProject(t);
  const realRoot = await fsp.realpath(project.root);

  const opencodePath = path.join(realRoot, '.opencode', 'opencode.json');
  await fsp.mkdir(path.dirname(opencodePath), { recursive: true });
  const originalText = '{"mcp":{"servers":{"strata_coder":{"type":"local","command":["node","other-server.js"]}}}}\n';
  await fsp.writeFile(opencodePath, originalText);

  const before = await snapshotHashes(realRoot);

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'],
    opencodeBin: bin,
  });
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const after = await snapshotHashes(realRoot);
  assert.equal(after['.opencode/opencode.json'], before['.opencode/opencode.json'], 'the OpenCode file must not be rewritten');
  assert.equal(readTextIfExists(opencodePath), originalText, `the OpenCode file was changed:\n${readTextIfExists(opencodePath)}`);

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(combined.includes('同名服务') || combined.includes('冲突'), `output must report the conflict:\n${combined}`);
});

test('an unsupported OpenCode version is reported without creating any OpenCode config', async t => {
  const bin = await makeFakeOpenCode(t, 'opencode v1.9.9');
  const project = await makeProject(t);
  const realRoot = await fsp.realpath(project.root);

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'],
    opencodeBin: bin,
  });
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  assert.equal(readTextIfExists(path.join(realRoot, '.opencode', 'opencode.json')), undefined, 'no OpenCode config may be created');

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(combined.includes('OpenCode'), `output must mention OpenCode:\n${combined}`);
  assert.ok(combined.includes('2.x') || combined.includes('版本'), `output must report the version problem:\n${combined}`);
});

test('a user-modified collaboration rules file is preserved byte-for-byte on re-init', async t => {
  const bin = await makeFakeOpenCode(t, 'opencode v2.0.22');
  const project = await makeProject(t);
  const realRoot = await fsp.realpath(project.root);
  const args = ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model'];

  const first = await runInit({ project: project.root, args, opencodeBin: bin });
  assert.equal(first.code, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);

  const rulesPath = path.join(realRoot, '.opencode', 'strata-coder.md');
  const rules = readTextIfExists(rulesPath);
  assert.ok(rules, `rules file was not created:\n${first.stdout}\n${first.stderr}`);

  const modified = `${rules}\n<!-- user edit -->\n`;
  await fsp.writeFile(rulesPath, modified);

  const second = await runInit({ project: project.root, args, opencodeBin: bin });
  assert.equal(second.code, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);

  assert.equal(readTextIfExists(rulesPath), modified, 'the user-modified rules file must be preserved byte-for-byte');

  const combined = `${second.stdout}\n${second.stderr}`;
  assert.ok(combined.includes('保留') || combined.includes('修改过'), `output must report the preserved file:\n${combined}`);
});

test('--check-command becomes the argv-array check when no test script is detected', async t => {
  const bin = await makeFakeOpenCode(t, 'opencode v2.0.22');
  const project = await makeProject(t, { packageJson: { name: 'demo', version: '1.0.0' } });
  const realRoot = await fsp.realpath(project.root);

  const result = await runInit({
    project: project.root,
    args: ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'smoke-model', '--check-command', 'npm run custom-check'],
    opencodeBin: bin,
  });
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const config = await readJson(path.join(realRoot, '.strata-coder', 'config.json'));
  assert.deepEqual(config.checks.strata_unit.command, ['npm', 'run', 'custom-check']);
  assert.deepEqual(config.defaultChecks, ['strata_unit']);
});

test('repeat init preserves edited settings and checks while removing the retired workspaceRoots field', async t => {
  const bin = await makeFakeOpenCode(t);
  const project = await makeProject(t);
  const file = path.join(project.root, '.strata-coder', 'config.json');
  const existing = { baseUrl: 'http://127.0.0.1:1/v1', model: 'existing', apiKeyEnv: '',
    stateDir: 'my-state', maxTaskSeconds: 60, maxRepairAttempts: 0, maxOutputTokens: 4000,
    exclude: ['private'], temperature: 0.2,
    checks: { custom: { command: ['node', '--test'], timeoutSeconds: 10 } }, defaultChecks: ['custom'] };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ ...existing, workspaceRoots: [project.root] }));
  const result = await runInit({ project: project.root, opencodeBin: bin });
  assert.equal(result.code, 0, result.stderr);
  const actual = await readJson(file);
  for (const [key, value] of Object.entries(existing)) assert.deepEqual(actual[key], value, key);
  assert.equal('workspaceRoots' in actual, false);
});

test('explicit check command wins over npm detection without deleting other checks', async t => {
  const bin = await makeFakeOpenCode(t);
  const project = await makeProject(t);
  const args = ['--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'test', '--check-command', 'node custom-check.js'];
  const result = await runInit({ project: project.root, args, opencodeBin: bin });
  assert.equal(result.code, 0, result.stderr);
  const file = path.join(project.root, '.strata-coder/config.json');
  const config = await readJson(file);
  assert.deepEqual(config.checks.strata_unit.command, ['node', 'custom-check.js']);
  config.checks.integration = { command: ['node', 'integration.js'], timeoutSeconds: 30 };
  config.defaultChecks.push('integration');
  await fsp.writeFile(file, JSON.stringify(config));
  const again = await runInit({ project: project.root, args, opencodeBin: bin });
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual((await readJson(file)).checks, config.checks);
  const invalid = await runInit({ project: project.root, args: [...args.slice(0, -1), 'node "unterminated'], opencodeBin: bin });
  assert.notEqual(invalid.code, 0);
  assert.deepEqual((await readJson(file)).checks, config.checks);
});

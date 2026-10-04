// Test the distributed tarball, rather than importing the working tree.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-coder-package-'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd, options = {}) => exec(command, args, { cwd, timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options });
const client = new Client({ name: 'package-validation', version: '1.0.0' });
const initClient = new Client({ name: 'package-init-validation', version: '1.0.0' });
try {
  const packed = JSON.parse((await run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], root)).stdout)[0];
  const files = packed.files.map(file => file.path);
  for (const required of ['src/mcp.js', 'src/worker.js', 'src/metadata.js', 'LICENSE', 'README.md', 'docs/AI-INSTALL.md', 'strata-coder.config.example.json']) {
    assert.ok(files.includes(required), `Missing ${required}`);
  }
  for (const file of files) {
    assert.ok(/^(src\/|prompts\/|examples\/|docs\/|scripts\/host-config\.js$|strata-coder\.config\.example\.json$|package\.json$|README\.md$|LICENSE$)/.test(file), `Unexpected published file ${file}`);
  }
  const consumer = path.join(scratch, '_npx', 'consumer');
  await fs.mkdir(consumer, { recursive: true });
  await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'test-consumer', private: true }));
  await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(scratch, packed.filename)], consumer);
  const binary = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'strata-coder.cmd' : 'strata-coder');
  assert.equal((await run(binary, ['--version'], consumer)).stdout.trim(), `${pkg.name} ${pkg.version}`);
  assert.match((await run(binary, ['--help'], consumer)).stdout, /MCP stdio/);
  const config = path.join(scratch, 'config.json');
  await fs.writeFile(config, JSON.stringify({
    baseUrl: 'http://127.0.0.1:1/v1', model: 'no-inference-needed', stateDir: path.join(scratch, 'state'),
  }));
  await client.connect(new StdioClientTransport({ command: binary, args: ['--config', config], cwd: consumer, stderr: 'pipe' }));
  assert.deepEqual(client.getServerVersion(), { name: pkg.name, version: pkg.version });
  const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ['cancel_task', 'get_capabilities', 'get_task', 'read_artifact', 'submit_task']);
  const result = await client.callTool({ name: 'get_capabilities', arguments: {} });
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).model, 'no-inference-needed');

  // `init` must work from the installed tarball, not from the working tree.
  const project = path.join(scratch, '项目 init');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({
    name: 'init-consumer', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await fs.writeFile(path.join(project, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3, packages: { '': { name: 'init-consumer', version: '1.0.0' } },
  }));

  // A deterministic fake OpenCode so the version probe does not depend on a real install.
  const fakeBin = path.join(scratch, 'fake-opencode-bin');
  await fs.mkdir(fakeBin);
  const fakeOpenCode = path.join(fakeBin, 'opencode');
  await fs.writeFile(fakeOpenCode, '#!/usr/bin/env node\nconsole.log("opencode v2.0.22");\n');
  await fs.chmod(fakeOpenCode, 0o755);

  const realProject = await fs.realpath(project);
  const installedRoot = await fs.realpath(path.join(consumer, 'node_modules', 'strata-coder'));
  const secret = 'PACKAGE_SECRET_0123456789';
  // execFile rejects on a non-zero exit code, so resolving here already proves exit code 0.
  await run(binary, ['init', '--yes', '--cwd', project, '--baseUrl', 'http://127.0.0.1:1/v1', '--model', 'tarball-model', '--apiKeyEnv', 'PACKAGE_INIT_KEY'], consumer, {
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, PACKAGE_INIT_KEY: secret },
  });

  const projectConfigText = await fs.readFile(path.join(realProject, '.strata-coder', 'config.json'), 'utf8');
  const projectConfig = JSON.parse(projectConfigText);
  assert.equal(projectConfig.model, 'tarball-model');
  assert.equal('workspaceRoots' in projectConfig, false);
  assert.equal(projectConfig.requireChecks, true);
  const checkCommand = projectConfig.checks?.strata_unit?.command ?? [];
  const helper = checkCommand.find(arg => typeof arg === 'string' && arg.endsWith('src/npm-check.js'));
  const stableRuntime = path.join(realProject, '.strata-coder', 'runtime');
  assert.ok(helper && helper.startsWith(stableRuntime), `check command must use the consumer-installed helper, got: ${checkCommand.join(' ')}`);
  assert.ok(checkCommand.includes('npm') && checkCommand.includes('test'), `check command must run npm test, got: ${checkCommand.join(' ')}`);
  assert.deepEqual(projectConfig.defaultChecks, ['strata_unit']);

  const opencodeConfigText = await fs.readFile(path.join(realProject, '.opencode', 'opencode.json'), 'utf8');
  const opencodeConfig = JSON.parse(opencodeConfigText);
  const serverCommand = opencodeConfig.mcp?.servers?.strata_coder?.command ?? [];
  const installedMcp = serverCommand[1];
  assert.ok(serverCommand.some(arg => typeof arg === 'string' && arg.endsWith('src/mcp.js') && arg.startsWith(stableRuntime)),
    `opencode command must reference the consumer-installed src/mcp.js, got: ${serverCommand.join(' ')}`);
  assert.ok(serverCommand.includes(path.join(realProject, '.strata-coder', 'config.json')),
    `opencode command must reference the project config, got: ${serverCommand.join(' ')}`);
  assert.equal(opencodeConfig.mcp.servers.strata_coder.type, 'local');
  assert.equal(opencodeConfig.mcp.servers.strata_coder.codemode, false);

  assert.ok(!projectConfigText.includes(secret), 'secret must not appear in the project config');
  assert.ok(!opencodeConfigText.includes(secret), 'secret must not appear in the opencode config');

  // Repeat init must keep the stable command/check, then remove the entire
  // disposable npx installation before exercising the generated configuration.
  await run(binary, ['init', '--yes', '--cwd', project], consumer, {
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(await fs.readFile(path.join(realProject, '.strata-coder', 'config.json'), 'utf8'), projectConfigText);
  await client.close();
  await fs.rm(consumer, { recursive: true, force: true });
  assert.ok(!installedMcp.startsWith(consumer));
  await run(process.execPath, [helper, '--', npm, 'test'], realProject);

  try {
    await initClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [installedMcp, '--config', path.join(realProject, '.strata-coder', 'config.json')],
      cwd: realProject,
      stderr: 'pipe',
    }));
    assert.deepEqual((await initClient.listTools()).tools.map(tool => tool.name).sort(),
      ['cancel_task', 'get_capabilities', 'get_task', 'read_artifact', 'submit_task']);
    const initResult = await initClient.callTool({ name: 'get_capabilities', arguments: {} });
    assert.ok(!initResult.isError);
    const capabilities = JSON.parse(initResult.content[0].text);
    assert.ok(capabilities.workspace.roots.includes(realProject), `workspace.roots must include ${realProject}, got: ${JSON.stringify(capabilities.workspace)}`);
    assert.ok(capabilities.checks.includes('strata_unit'), `checks must include strata_unit, got: ${JSON.stringify(capabilities.checks)}`);
  } finally {
    await initClient.close();
  }

  console.log(JSON.stringify({ passed: true, package: packed.filename, files: files.length, bytes: packed.size, checks: ['file allowlist', 'clean install', 'bin version/help', 'MCP handshake', 'five tools', 'capabilities', 'init config', 'init opencode command', 'init handshake after npx cache removal', 'check after npx cache removal', 'no secret in generated files'] }));
} finally {
  await client.close();
  await fs.rm(scratch, { recursive: true, force: true });
}

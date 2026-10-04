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
const run = (command, args, cwd) => exec(command, args, { cwd, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
const client = new Client({ name: 'package-validation', version: '1.0.0' });
try {
  const packed = JSON.parse((await run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], root)).stdout)[0];
  const files = packed.files.map(file => file.path);
  for (const required of ['src/mcp.js', 'src/worker.js', 'src/metadata.js', 'LICENSE', 'README.md', 'strata-coder.config.example.json']) {
    assert.ok(files.includes(required), `Missing ${required}`);
  }
  for (const file of files) {
    assert.ok(/^(src\/|prompts\/|examples\/|docs\/|scripts\/host-config\.js$|strata-coder\.config\.example\.json$|package\.json$|README\.md$|LICENSE$)/.test(file), `Unexpected published file ${file}`);
  }
  const consumer = path.join(scratch, 'consumer');
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'test-consumer', private: true }));
  await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(scratch, packed.filename)], consumer);
  const binary = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'strata-coder.cmd' : 'strata-coder');
  assert.equal((await run(binary, ['--version'], consumer)).stdout.trim(), `${pkg.name} ${pkg.version}`);
  assert.match((await run(binary, ['--help'], consumer)).stdout, /MCP stdio/);
  const config = path.join(scratch, 'config.json');
  await fs.writeFile(config, JSON.stringify({
    baseUrl: 'http://127.0.0.1:1/v1', model: 'no-inference-needed', workspaceRoots: [consumer], stateDir: path.join(scratch, 'state'),
  }));
  await client.connect(new StdioClientTransport({ command: binary, args: ['--config', config], stderr: 'pipe' }));
  assert.deepEqual(client.getServerVersion(), { name: pkg.name, version: pkg.version });
  const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ['cancel_task', 'get_capabilities', 'get_task', 'read_artifact', 'submit_task']);
  const result = await client.callTool({ name: 'get_capabilities', arguments: {} });
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).model, 'no-inference-needed');
  console.log(JSON.stringify({ passed: true, package: packed.filename, files: files.length, bytes: packed.size, checks: ['file allowlist', 'clean install', 'bin version/help', 'MCP handshake', 'five tools', 'capabilities'] }));
} finally {
  await client.close();
  await fs.rm(scratch, { recursive: true, force: true });
}

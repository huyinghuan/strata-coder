import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, mockModel, call, waitDone } from './helpers.js';
import { cancelTask } from '../src/jobs.js';
import { metadata } from '../src/metadata.js';

async function connect(t, configPath, cwd) {
  const client = new Client({ name: 'test-host', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url)), '--config', configPath], cwd, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

const entryPath = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function runEntry(args, { cwd, env, entry = entryPath } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: cwd ?? process.cwd(), env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.STRATA_CODER_CONFIG;
  delete env.LOCAL_CODER_CONFIG;
  return env;
}

async function connectArgs(t, args, { cwd, env } = {}) {
  const client = new Client({ name: 'test-host', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [entryPath, ...args], cwd, env, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

test('MCP stdio supports discovery, validation, persistent jobs and artifact pagination', async t => {
  const model = await mockModel(t, (_, n) => n === 1
    ? call('replace_text', { path: 'src/math.cjs', old_text: 'a - b', new_text: 'a + b' })
    : { content: 'Fixed add.' });
  const { configPath, task, workspace } = await fixture(t, { baseUrl: model.url });
  const client = await connect(t, configPath, workspace);
  assert.deepEqual(client.getServerVersion(), metadata);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ['cancel_task', 'get_capabilities', 'get_task', 'read_artifact', 'submit_task']);
  assert.equal((await callTool(client, 'get_capabilities')).model, 'test-model');
  const invalid = await client.callTool({ name: 'submit_task', arguments: { ...task, acceptance: [] } });
  assert.equal(invalid.isError, true);
  const submitted = await callTool(client, 'submit_task', task);
  await client.close();
  const reconnected = await connect(t, configPath, workspace);
  const done = await callTool(reconnected, 'get_task', { task_id: submitted.task_id, wait_seconds: 20 });
  assert.equal(done.status, 'ready_for_review', JSON.stringify(done));
  const artifact = await callTool(reconnected, 'read_artifact', { task_id: done.task_id, artifact: 'patch', offset: 0, limit: 10 });
  assert.equal(artifact.content.length, 10);
  assert.equal(artifact.next_offset, 10);
});

test('separate MCP hosts deduplicate simultaneous submissions', async t => {
  const model = await mockModel(t, async () => { await new Promise(r => setTimeout(r, 1000)); return { content: 'done' }; });
  const { config, task, configPath, workspace } = await fixture(t, { baseUrl: model.url });
  const clients = await Promise.all([connect(t, configPath, workspace), connect(t, configPath, workspace), connect(t, configPath, workspace)]);
  const results = await Promise.all(clients.map(client => callTool(client, 'submit_task', task)));
  const ids = results.map(result => result.task_id);
  assert.equal(new Set(ids).size, 1);
  cancelTask(config, ids[0]);
  assert.equal((await waitDone(config, ids[0])).status, 'cancelled');
});

test('real entry applies CLI overrides before serving capabilities', async t => {
  const { configPath } = await fixture(t, { baseUrl: 'http://127.0.0.1:1/v1' });
  const client = await connectArgs(t, ['--config', configPath, '--model', 'cli-model']);
  const capabilities = await callTool(client, 'get_capabilities');
  assert.equal(capabilities.model, 'cli-model');
});

test('init subcommand is dispatched from the real entry', async t => {
  const result = await runEntry(['init', '--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('strata-coder init'), result.stdout);
});

test('the real entry fails clearly when no configuration exists', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-entry-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.cp(path.join(repoRoot, 'src'), path.join(temp, 'src'), { recursive: true });
  await fs.copyFile(path.join(repoRoot, 'package.json'), path.join(temp, 'package.json'));
  await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  const result = await runEntry([], { cwd: temp, env: cleanEnv(), entry: path.join(temp, 'src', 'mcp.js') });
  assert.equal(result.code, 1, result.stdout);
  assert.ok(result.stderr.includes('init'), result.stderr);
});

test('a project-local .strata-coder/config.json is discovered from the working directory', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-project-'));
  const realProject = await fs.realpath(project);
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, '.strata-coder'));
  await fs.writeFile(path.join(project, '.strata-coder', 'config.json'), JSON.stringify({
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'project-model',
    stateDir: 'state',
  }));
  const client = await connectArgs(t, [], { cwd: project, env: cleanEnv() });
  const capabilities = await callTool(client, 'get_capabilities');
  assert.equal(capabilities.model, 'project-model');
  assert.ok(Array.isArray(capabilities.workspace.roots));
  assert.ok(capabilities.workspace.roots.includes(realProject), JSON.stringify(capabilities));
  assert.equal(capabilities.workspace.source, 'cwd');
});

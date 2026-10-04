import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixture, mockModel, call, waitDone } from './helpers.js';

const entryPath = fileURLToPath(new URL('../src/mcp.js', import.meta.url));

// Every connection owns its own scope: the host below advertises the roots
// capability and answers roots/list from a mutable ref, so a test can change
// the roots after a task was submitted.
async function rootsHost(t, { configPath, rootsRef, failRef, cwd }) {
  const client = new Client({ name: 'roots-host', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    if (failRef?.value) throw new Error(failRef.value);
    // The SDK client validates the response, so normalize plain strings.
    const roots = (rootsRef.value ?? []).map(entry => (typeof entry === 'string' ? { uri: entry } : entry));
    return { roots };
  });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [entryPath, '--config', configPath], cwd, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

// A host that never advertises roots: the server must fall back to the
// directory the process was started in.
async function plainHost(t, { configPath, cwd }) {
  const client = new Client({ name: 'plain-host', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [entryPath, '--config', configPath], cwd, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

// Tool results are JSON text; errors are reported as isError payloads, so the
// parsed body is read even when the call failed.
async function callJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { parsed: JSON.parse(result.content[0].text), result };
}

function uri(p) {
  return pathToFileURL(p).toString();
}

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function realPath(p) {
  return fs.realpath(p);
}

async function readJobJson(config, id) {
  return JSON.parse(await fs.readFile(path.join(config.stateDir, 'jobs', id, 'job.json'), 'utf8'));
}

// Poll a read-only tool until the connection reports the new roots.
async function pollCapabilities(client, match, attempts = 20) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const { parsed, result } = await callJson(client, 'get_capabilities');
    if (!result.isError && match(parsed)) return parsed;
    last = parsed;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`capabilities never matched: ${JSON.stringify(last)}`);
}

function taskWithoutWorkspace(fixtureTask) {
  const { workspace: _omitted, ...rest } = fixtureTask;
  return rest;
}

test('single MCP root becomes the connection workspace and is used when omitted', async t => {
  const model = await mockModel(t, (_, n) => n === 1
    ? call('replace_text', { path: 'src/math.cjs', old_text: 'a - b', new_text: 'a + b' })
    : { content: 'done' });
  const { configPath, config, task, workspace } = await fixture(t, { baseUrl: model.url });
  const rootsRef = { value: [uri(workspace)] };
  const client = await rootsHost(t, { configPath, rootsRef, cwd: workspace });

  const capabilities = (await callJson(client, 'get_capabilities')).parsed;
  const realWorkspace = await realPath(workspace);
  assert.equal(capabilities.workspace.source, 'mcp_roots', JSON.stringify(capabilities));
  assert.deepEqual(capabilities.workspace.roots, [realWorkspace]);
  assert.equal(capabilities.workspace.default, realWorkspace);
  assert.equal(capabilities.workspace.error, null);

  const submitted = (await callJson(client, 'submit_task', taskWithoutWorkspace(task))).parsed;
  assert.ok(typeof submitted.task_id === 'string' && submitted.task_id.length > 0, JSON.stringify(submitted));
  const done = await callJson(client, 'get_task', { task_id: submitted.task_id, wait_seconds: 20 });
  assert.ok(!done.result.isError, JSON.stringify(done.result));
  assert.ok(done.parsed.task_id === submitted.task_id, JSON.stringify(done.parsed));
  assert.ok(['ready_for_review', 'failed', 'cancelled', 'unverified'].includes(done.parsed.status), JSON.stringify(done.parsed));

  const job = await readJobJson(config, submitted.task_id);
  assert.equal(job.task.workspace, realWorkspace, JSON.stringify(job.task));
});

test('multiple roots force an explicit choice and list the candidates', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  const { configPath, workspace } = await fixture(t, { baseUrl: model.url, requireChecks: false, checks: {}, defaultChecks: [] });
  const rootA = await realPath(workspace);
  const rootB = await tempDir(t, 'strata-scope-rootB-');
  const realRootB = await realPath(rootB);
  const rootsRef = { value: [uri(rootA), uri(rootB)] };
  const client = await rootsHost(t, { configPath, rootsRef, cwd: rootA });

  const capabilities = (await callJson(client, 'get_capabilities')).parsed;
  assert.deepEqual(capabilities.workspace.roots, [rootA, realRootB]);
  assert.equal(capabilities.workspace.default, null, JSON.stringify(capabilities));

  const { parsed, result } = await callJson(client, 'submit_task', taskWithoutWorkspace({
    workspace, task: 'noop task for multiple roots', acceptance: ['nothing to verify'],
    allowed_paths: ['src'], request_id: 'multi-roots-001',
  }));
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(parsed.code, 'multiple_workspaces', JSON.stringify(parsed));
  assert.deepEqual(parsed.candidates, [rootA, realRootB].sort());
});

test('a subdirectory of a root can be selected explicitly; outside the roots is rejected', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  const { configPath, config, task, workspace } = await fixture(t, { baseUrl: model.url });
  const parent = path.dirname(workspace);
  const realWorkspace = await realPath(workspace);
  const rootsRef = { value: [uri(parent)] };
  const client = await rootsHost(t, { configPath, rootsRef, cwd: parent });

  const inside = await callJson(client, 'submit_task', { ...task, workspace });
  assert.ok(!inside.result.isError, JSON.stringify(inside.result));
  const job = await readJobJson(config, inside.parsed.task_id);
  assert.equal(job.task.workspace, realWorkspace, JSON.stringify(job.task));

  const outside = await tempDir(t, 'strata-scope-outside-');
  const rejected = await callJson(client, 'submit_task', { ...task, workspace: outside, request_id: 'outside-001' });
  assert.equal(rejected.result.isError, true, JSON.stringify(rejected.result));
  assert.equal(rejected.parsed.code, 'workspace_outside_scope', JSON.stringify(rejected.parsed));
});

test('a failing roots request is reported as an error and never falls back to the startup cwd', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  const { configPath, workspace } = await fixture(t, { baseUrl: model.url, requireChecks: false, checks: {}, defaultChecks: [] });
  const rootsRef = { value: [uri(workspace)] };
  const failRef = { value: 'boom' };
  const client = await rootsHost(t, { configPath, rootsRef, failRef, cwd: workspace });

  const capabilities = (await callJson(client, 'get_capabilities')).parsed;
  assert.match(capabilities.workspace.error, /roots/, JSON.stringify(capabilities));
  assert.deepEqual(capabilities.workspace.roots, []);
  assert.equal(capabilities.workspace.source, null);

  const noWorkspace = await callJson(client, 'submit_task', taskWithoutWorkspace({
    workspace, task: 'noop task with failed roots', acceptance: ['nothing to verify'],
    allowed_paths: ['src'], request_id: 'roots-failed-001',
  }));
  assert.equal(noWorkspace.result.isError, true, JSON.stringify(noWorkspace.result));
  assert.equal(noWorkspace.parsed.code, 'workspace_unavailable', JSON.stringify(noWorkspace.parsed));

  // An explicit directory under the startup cwd must not rescue the failed roots.
  const explicit = await callJson(client, 'submit_task', {
    workspace, task: 'noop task with explicit workspace', acceptance: ['nothing to verify'],
    allowed_paths: ['src'], request_id: 'roots-failed-002', check_names: ['unit'],
  });
  assert.equal(explicit.result.isError, true, JSON.stringify(explicit.result));
  assert.equal(explicit.parsed.code, 'workspace_unavailable', JSON.stringify(explicit.parsed));
});

test('an empty roots array falls back to the startup working directory', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  const { configPath, workspace } = await fixture(t, { baseUrl: model.url });
  const rootsRef = { value: [] };
  const client = await rootsHost(t, { configPath, rootsRef, cwd: workspace });
  const capabilities = (await callJson(client, 'get_capabilities')).parsed;
  assert.equal(capabilities.workspace.source, 'cwd', JSON.stringify(capabilities));
  assert.equal(capabilities.workspace.reason, 'empty_roots', JSON.stringify(capabilities));
  assert.deepEqual(capabilities.workspace.roots, [await realPath(workspace)]);
});

test('a client without the roots capability falls back to the startup working directory', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  const { configPath, workspace } = await fixture(t, { baseUrl: model.url });
  const client = await plainHost(t, { configPath, cwd: workspace });
  const capabilities = (await callJson(client, 'get_capabilities')).parsed;
  assert.equal(capabilities.workspace.source, 'cwd', JSON.stringify(capabilities));
  assert.equal(capabilities.workspace.reason, 'client_unsupported_roots', JSON.stringify(capabilities));
  assert.deepEqual(capabilities.workspace.roots, [await realPath(workspace)]);
});

test('a roots update only affects future submissions; old tasks keep their directory but lose access', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  const { configPath, config, task, workspace } = await fixture(t, { baseUrl: model.url, requireChecks: false, checks: {}, defaultChecks: [] });
  const rootsRef = { value: [uri(workspace)] };
  const client = await rootsHost(t, { configPath, rootsRef, cwd: workspace });

  const submitted = (await callJson(client, 'submit_task', taskWithoutWorkspace(task))).parsed;
  assert.ok(typeof submitted.task_id === 'string' && submitted.task_id.length > 0, JSON.stringify(submitted));
  const before = await callJson(client, 'get_task', { task_id: submitted.task_id, wait_seconds: 0 });
  assert.ok(!before.result.isError, JSON.stringify(before.result));
  await waitDone(config, submitted.task_id);

  const otherDir = await tempDir(t, 'strata-scope-other-');
  const realOtherDir = await realPath(otherDir);
  rootsRef.value = [uri(otherDir)];
  await client.sendRootsListChanged();
  const updated = await pollCapabilities(client, capabilities =>
    capabilities.workspace.source === 'mcp_roots' && capabilities.workspace.roots.length === 1 && capabilities.workspace.roots[0] === realOtherDir);
  assert.deepEqual(updated.workspace.roots, [realOtherDir]);

  const old = await callJson(client, 'get_task', { task_id: submitted.task_id, wait_seconds: 0 });
  assert.equal(old.result.isError, true, JSON.stringify(old.result));
  assert.match(old.parsed.error, /outside this connection roots/, JSON.stringify(old.parsed));

  const artifact = await callJson(client, 'read_artifact', { task_id: submitted.task_id, artifact: 'patch' });
  assert.equal(artifact.result.isError, true, JSON.stringify(artifact.result));
  assert.match(artifact.parsed.error, /outside this connection roots/, JSON.stringify(artifact.parsed));

  const cancel = await callJson(client, 'cancel_task', { task_id: submitted.task_id });
  assert.equal(cancel.result.isError, true, JSON.stringify(cancel.result));
  assert.match(cancel.parsed.error, /outside this connection roots/, JSON.stringify(cancel.parsed));

  // The execution directory recorded at submission time is unchanged.
  const job = await readJobJson(config, submitted.task_id);
  assert.equal(job.task.workspace, await realPath(workspace), JSON.stringify(job.task));
});

test('two connections never share or cross their task scopes', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  // Both connections share one stateDir, so the scope check (not a missing
  // job record) is what rejects the cross-connection query.
  const sharedState = await tempDir(t, 'strata-scope-state-');
  const a = await fixture(t, { baseUrl: model.url, requireChecks: false, checks: {}, defaultChecks: [], stateDir: sharedState });
  const b = await fixture(t, { baseUrl: model.url, requireChecks: false, checks: {}, defaultChecks: [], stateDir: sharedState });
  const realA = await realPath(a.workspace);
  const realB = await realPath(b.workspace);

  const rootsA = { value: [uri(a.workspace)] };
  const rootsB = { value: [uri(b.workspace)] };
  const clientA = await rootsHost(t, { configPath: a.configPath, rootsRef: rootsA, cwd: a.workspace });
  const clientB = await rootsHost(t, { configPath: b.configPath, rootsRef: rootsB, cwd: b.workspace });

  assert.deepEqual((await callJson(clientA, 'get_capabilities')).parsed.workspace.roots, [realA]);
  assert.deepEqual((await callJson(clientB, 'get_capabilities')).parsed.workspace.roots, [realB]);

  const submitted = (await callJson(clientA, 'submit_task', taskWithoutWorkspace(a.task))).parsed;
  assert.ok(typeof submitted.task_id === 'string' && submitted.task_id.length > 0, JSON.stringify(submitted));

  const cross = await callJson(clientB, 'get_task', { task_id: submitted.task_id, wait_seconds: 0 });
  assert.equal(cross.result.isError, true, JSON.stringify(cross.result));
  assert.match(cross.parsed.error, /outside this connection roots/, JSON.stringify(cross.parsed));

  const own = await callJson(clientA, 'get_task', { task_id: submitted.task_id, wait_seconds: 20 });
  assert.ok(!own.result.isError, JSON.stringify(own.result));
  assert.ok(typeof own.parsed.status === 'string', JSON.stringify(own.parsed));
});

test('a Chinese, spaced and percent-encoded root resolves to the real directory', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  const { configPath } = await fixture(t, { baseUrl: model.url });
  const dir = await tempDir(t, 'strata-scope-');
  const named = path.join(dir, '项目 100% 目录');
  await fs.mkdir(named);
  const rootsRef = { value: [uri(named)] };
  const client = await rootsHost(t, { configPath, rootsRef, cwd: dir });
  const capabilities = (await callJson(client, 'get_capabilities')).parsed;
  assert.equal(capabilities.workspace.source, 'mcp_roots', JSON.stringify(capabilities));
  assert.deepEqual(capabilities.workspace.roots, [await realPath(named)]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, mockModel, call, waitDone } from './helpers.js';
import { cancelTask } from '../src/jobs.js';
import { metadata } from '../src/metadata.js';

async function connect(t, configPath) {
  const client = new Client({ name: 'test-host', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url)), '--config', configPath], stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

test('MCP stdio supports discovery, validation, persistent jobs and artifact pagination', async t => {
  const model = await mockModel(t, (_, n) => n === 1
    ? call('replace_text', { path: 'src/math.cjs', old_text: 'a - b', new_text: 'a + b' })
    : { content: 'Fixed add.' });
  const { configPath, task } = await fixture(t, { baseUrl: model.url });
  const client = await connect(t, configPath);
  assert.deepEqual(client.getServerVersion(), metadata);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ['cancel_task', 'get_capabilities', 'get_task', 'read_artifact', 'submit_task']);
  assert.equal((await callTool(client, 'get_capabilities')).model, 'test-model');
  const invalid = await client.callTool({ name: 'submit_task', arguments: { ...task, acceptance: [] } });
  assert.equal(invalid.isError, true);
  const submitted = await callTool(client, 'submit_task', task);
  await client.close();
  const reconnected = await connect(t, configPath);
  const done = await callTool(reconnected, 'get_task', { task_id: submitted.task_id, wait_seconds: 20 });
  assert.equal(done.status, 'ready_for_review', JSON.stringify(done));
  const artifact = await callTool(reconnected, 'read_artifact', { task_id: done.task_id, artifact: 'patch', offset: 0, limit: 10 });
  assert.equal(artifact.content.length, 10);
  assert.equal(artifact.next_offset, 10);
});

test('separate MCP hosts deduplicate simultaneous submissions', async t => {
  const model = await mockModel(t, async () => { await new Promise(r => setTimeout(r, 1000)); return { content: 'done' }; });
  const { config, task, configPath } = await fixture(t, { baseUrl: model.url });
  const clients = await Promise.all([connect(t, configPath), connect(t, configPath), connect(t, configPath)]);
  const results = await Promise.all(clients.map(client => callTool(client, 'submit_task', task)));
  const ids = results.map(result => result.task_id);
  assert.equal(new Set(ids).size, 1);
  cancelTask(config, ids[0]);
  assert.equal((await waitDone(config, ids[0])).status, 'cancelled');
});

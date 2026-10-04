import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { getTask, terminal, cancelTask } from '../src/jobs.js';

export async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-test-'));
  const workspace = path.join(dir, 'project');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'test'));
  await fs.writeFile(path.join(workspace, 'src/math.cjs'), 'exports.add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(workspace, 'test/math.test.cjs'), "const {test} = require('node:test'); const assert = require('node:assert/strict'); const {add} = require('../src/math.cjs'); test('addition', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n");
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model', stateDir: path.join(dir, 'state'),
    maxTurns: 8, maxTaskSeconds: 30, requestTimeoutSeconds: 5,
    checks: { unit: { command: [process.execPath, '--test', 'test/math.test.cjs'], timeoutSeconds: 5 } }, defaultChecks: ['unit'],
    ...overrides,
  }));
  const config = loadConfig(configPath);
  const task = { workspace, task: 'Fix add(a,b) to add numbers.', acceptance: ['add(2,3) returns 5', 'existing tests pass'],
    allowed_paths: ['src'], request_id: 'fix-add-001' };
  t.after(async () => {
    try {
      const jobs = await fs.readdir(path.join(config.stateDir, 'jobs'));
      for (const id of jobs) {
        try { cancelTask(config, id); await waitDone(config, id); } catch { /* already gone */ }
      }
    } catch { /* no jobs */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, workspace, configPath, config, task };
}

export async function mockModel(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return; }
      let data = '';
      for await (const chunk of req) data += chunk;
      const body = JSON.parse(data); requests.push(body);
      const result = await handler(body, requests.length);
      if (!res.destroyed) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...result }, finish_reason: result.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      }
    } catch (e) { res.statusCode = 500; res.end(e.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

export function call(name, args) {
  return { content: null, tool_calls: [{ id: `call-${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

export async function waitDone(config, id, maxMs = 15000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const state = await getTask(config, id, 1);
    if (terminal.has(state.status)) return state;
  }
  throw new Error(`Task did not stop within ${maxMs}ms: ${id}`);
}

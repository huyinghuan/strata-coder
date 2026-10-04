// Runs a real, small coding task through MCP against the configured local model.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { terminal } from '../src/jobs.js';
import { runCommand } from '../src/process.js';

const filename = process.argv[2] || (process.env.STRATA_CODER_CONFIG || process.env.LOCAL_CODER_CONFIG) || 'local-coder.config.json';
const base = loadConfig(filename);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-smoke-'));
const workspace = path.join(dir, 'project');
await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
await fs.mkdir(path.join(workspace, 'test'));
const initial = 'exports.paginate = function paginate(items, options = {}) {\n  throw new Error("Not implemented");\n};\n';
await fs.writeFile(path.join(workspace, 'src/paginate.cjs'), initial);
await fs.writeFile(path.join(workspace, 'test/paginate.test.cjs'), `const {test} = require('node:test');
const assert = require('node:assert/strict');
const {paginate} = require('../src/paginate.cjs');
test('defaults and empty input', () => {
  assert.deepEqual(paginate([]), {items: [], total: 0, page: 1, pageSize: 10, totalPages: 0});
  assert.deepEqual(paginate([1,2]), {items: [1,2], total: 2, page: 1, pageSize: 10, totalPages: 1});
});
test('page boundaries and nonmutation', () => {
  const input = [1,2,3,4,5];
  assert.deepEqual(paginate(input, {page: 2, pageSize: 2}), {items: [3,4], total: 5, page: 2, pageSize: 2, totalPages: 3});
  assert.deepEqual(paginate(input, {page: 3, pageSize: 2}).items, [5]);
  assert.deepEqual(paginate(input, {page: 4, pageSize: 2}).items, []);
  assert.deepEqual(input, [1,2,3,4,5]);
});
test('reject invalid arguments', () => {
  assert.throws(() => paginate(null), TypeError);
  for (const value of [0, -1, 1.5, '2', NaN, Infinity]) {
    assert.throws(() => paginate([], {page: value}), RangeError);
    assert.throws(() => paginate([], {pageSize: value}), RangeError);
  }
});
`);
const { configPath: _, ...raw } = base;
const smokeConfig = { ...raw, workspaceRoots: [workspace], stateDir: path.join(base.stateDir, 'smoke'),
  checks: { unit: { command: [process.execPath, '--test', 'test/paginate.test.cjs'], timeoutSeconds: 15 } }, defaultChecks: ['unit'] };
const configPath = path.join(dir, 'config.json');
await fs.writeFile(configPath, JSON.stringify(smokeConfig, null, 2));
const client = new Client({ name: 'local-coder-live-smoke', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url)), '--config', configPath], stderr: 'inherit' }));
const invoke = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
let taskId;
const started = Date.now();
try {
  const submitted = await invoke('submit_task', {
    workspace, task: 'Implement paginate(items, options={}) in src/paginate.cjs. Read the existing file and tests. Return {items,total,page,pageSize,totalPages}. Defaults: page=1, pageSize=10. Reject non-array items with TypeError and non-positive/non-integer page/pageSize with RangeError. Preserve the input array. Empty input has totalPages=0. An out-of-range page returns empty items. Use tools to implement and run the configured unit check.',
    acceptance: ['All existing tests pass without changing tests', 'No mutation of input array', 'Preserve the CommonJS export'],
    allowed_paths: ['src/paginate.cjs'], check_names: ['unit'], request_id: 'live-pagination-001',
  });
  taskId = submitted.task_id;
  console.log(JSON.stringify({ event: 'submitted', task_id: taskId, workspace, config_path: configPath }));
  let done;
  do {
    done = await invoke('get_task', { task_id: taskId, wait_seconds: 20 });
    console.log(JSON.stringify({ status: done.status, stage: done.stage, iterations: done.iterations, usage: done.usage }));
  } while (!terminal.has(done.status));
  const unchanged = await fs.readFile(path.join(workspace, 'src/paginate.cjs'), 'utf8') === initial;
  const report = { time: new Date().toISOString(), duration_seconds: (Date.now() - started) / 1000,
    original_untouched_before_apply: unchanged, workspace, config_path: configPath, result: done };
  const reportPath = path.join(base.stateDir, 'smoke-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  assert.equal(done.status, 'ready_for_review', JSON.stringify(done));
  assert.equal(done.verification, 'configured_checks_passed');
  assert.equal(unchanged, true);
  const patch = done.artifacts.patch;
  const preflight = await runCommand(['git', 'apply', '--check', patch], { cwd: workspace });
  assert.equal(preflight.exit_code, 0, preflight.output);
  const apply = await runCommand(['git', 'apply', patch], { cwd: workspace });
  assert.equal(apply.exit_code, 0, apply.output);
  const verification = await runCommand(smokeConfig.checks.unit.command, { cwd: workspace });
  assert.equal(verification.exit_code, 0, verification.output);
  report.patch_applied_and_independently_tested = true;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: 'passed', report: reportPath, usage: done.usage }));
} finally {
  if (taskId) await invoke('cancel_task', { task_id: taskId }).catch(() => {});
  await client.close();
}

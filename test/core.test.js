import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, mockModel, call, waitDone } from './helpers.js';
import { submitTask, getTask, cancelTask, readArtifact } from '../src/jobs.js';
import { createExecutor } from '../src/agent.js';
import { snapshot, diffArtifacts } from '../src/workspace.js';
import { runCommand } from '../src/process.js';
import { modelRequest } from '../src/model.js';

test('reasoning effort can be omitted for compatible endpoints without that parameter', async t => {
  const model = await mockModel(t, () => ({ content: 'OK' }));
  const { config } = await fixture(t, { baseUrl: model.url, reasoningEffort: null });
  await modelRequest(config, [{ role: 'user', content: 'Reply OK' }], [], new AbortController().signal);
  assert.equal(Object.hasOwn(model.requests[0], 'reasoning_effort'), false);
});

test('real worker edits a copy, reruns checks, creates applicable patch, and retries idempotently', async t => {
  const model = await mockModel(t, (_, n) => {
    if (n === 1) return call('read_file', { path: 'src/math.cjs' });
    if (n === 2) return call('replace_text', { path: 'src/math.cjs', old_text: 'a - b', new_text: 'a + b' });
    if (n === 3) return call('run_check', { name: 'unit' });
    return { content: 'Implemented addition.' };
  });
  const { config, task, workspace, dir } = await fixture(t, { baseUrl: model.url });
  const submitted = await submitTask(config, task);
  const duplicate = await submitTask(config, task);
  assert.equal(duplicate.task_id, submitted.task_id);
  const done = await waitDone(config, submitted.task_id);
  assert.equal(done.status, 'ready_for_review', JSON.stringify(done));
  assert.equal(done.verification, 'configured_checks_passed');
  assert.deepEqual(done.changed_files, ['src/math.cjs']);
  assert.equal(done.checks[0].final, true);
  assert.equal(done.checks[0].passed, true);
  assert.equal(done.usage.requests, 4);
  assert.equal(done.usage.total_tokens, 480);
  assert.ok(done.usage.model_seconds > 0);
  assert.ok(done.elapsed_seconds > 0);
  assert.equal(model.requests[0].temperature, 0);
  assert.equal(model.requests[0].reasoning_effort, 'low');
  assert.equal(model.requests[0].max_tokens, 13000);
  assert.equal(done.config, undefined);
  assert.match(await fs.readFile(path.join(workspace, 'src/math.cjs'), 'utf8'), /a - b/);
  const patch = readArtifact(config, done.task_id, 'patch');
  assert.match(patch.content, /\+exports.add = \(a, b\) => a \+ b/);
  assert.equal(readArtifact(config, done.task_id, 'patch', 0, 5).next_offset, 5);
  const patchPath = path.join(dir, 'review.patch'); await fs.writeFile(patchPath, patch.content);
  assert.equal((await runCommand(['git', 'apply', '--check', patchPath], { cwd: workspace })).exit_code, 0);
  assert.equal((await runCommand(['git', 'apply', patchPath], { cwd: workspace })).exit_code, 0);
  assert.equal((await runCommand([process.execPath, '--test', 'test/math.test.cjs'], { cwd: workspace })).exit_code, 0);
  await assert.rejects(submitTask(config, { ...task, task: 'Different task' }), /different arguments/);
});

test('scope, traversal, symlinks, secret files and unknown checks are rejected', async t => {
  const { config, task, workspace, dir } = await fixture(t);
  const executor = createExecutor({ config, task: { ...task, check_names: ['unit'] }, root: workspace, signal: new AbortController().signal, onCheck: () => {} });
  for (const relative of ['../outside', '/tmp/outside', '.git/config', 'src/../../escape', '.env', '.env.production', 'src\\escape']) {
    await assert.rejects(executor.execute('write_file', { path: relative, content: 'bad' }));
  }
  await assert.rejects(executor.execute('write_file', { path: 'test/math.test.cjs', content: 'bad' }), /outside allowed/);
  await fs.symlink(dir, path.join(workspace, 'src/link'));
  await assert.rejects(executor.execute('write_file', { path: 'src/link/escaped', content: 'bad' }), /Symlinks/);
  await assert.rejects(executor.execute('run_check', { name: 'arbitrary' }), /not enabled/);
  await assert.rejects(submitTask(config, { ...task, workspace: dir }), /outside configured/);
  await assert.rejects(submitTask(config, { ...task, check_names: ['missing'] }), /Unknown check/);
  await assert.rejects(executor.execute('replace_text', { path: 'src/math.cjs', old_text: 'missing', new_text: 'x' }), /exactly once/);
});

test('snapshot includes dirty and untracked files while excluding secrets and preserving original', async t => {
  const { config, task, workspace, dir } = await fixture(t);
  await runCommand(['git', 'init', '--quiet'], { cwd: workspace });
  await runCommand(['git', 'add', 'src/math.cjs'], { cwd: workspace });
  await fs.writeFile(path.join(workspace, 'src/math.cjs'), 'exports.add = (a, b) => a * b;\n');
  await fs.writeFile(path.join(workspace, '.env'), 'SECRET=not-copied');
  await fs.writeFile(path.join(workspace, 'note.txt'), 'untracked input');
  const copy = path.join(dir, 'copy');
  const result = await snapshot(workspace, copy, config);
  assert.equal(await fs.readFile(path.join(copy, 'note.txt'), 'utf8'), 'untracked input');
  assert.match(await fs.readFile(path.join(copy, 'src/math.cjs'), 'utf8'), /a \* b/);
  await assert.rejects(fs.stat(path.join(copy, '.env')), { code: 'ENOENT' });
  assert.equal(result.skipped_count, 1);
  await fs.writeFile(path.join(copy, 'src/new.cjs'), 'exports.newValue = 1;\n');
  await fs.unlink(path.join(copy, 'src/math.cjs'));
  const diff = await diffArtifacts(copy, task, config);
  assert.deepEqual(diff.changed_files.sort(), ['src/math.cjs', 'src/new.cjs']);
  assert.equal(diff.out_of_scope.length, 0);
  await fs.writeFile(path.join(copy, 'note.txt'), 'changed outside allowed scope');
  assert.deepEqual((await diffArtifacts(copy, task, config)).out_of_scope, ['note.txt']);
});

test('final verification failures are repaired locally instead of reporting false success', async t => {
  const model = await mockModel(t, (_, n) => {
    if (n === 1) return { content: 'Done; all tests pass.' };
    if (n === 2) return call('replace_text', { path: 'src/math.cjs', old_text: 'a - b', new_text: 'a + b' });
    return { content: 'Fixed implementation.' };
  });
  const { config, task } = await fixture(t, { baseUrl: model.url });
  const submitted = await submitTask(config, task);
  const done = await waitDone(config, submitted.task_id);
  assert.equal(done.status, 'ready_for_review', JSON.stringify(done));
  const records = JSON.parse(readArtifact(config, done.task_id, 'checks').content);
  assert.equal(records.length, 2);
  assert.equal(records[0].passed, false);
  assert.equal(records[1].passed, true);
  assert.match(model.requests[1].messages.at(-1).content, /Independent final checks failed/);
});

test('an ignored nested project must not silently become an empty snapshot', async t => {
  const { config, workspace, dir } = await fixture(t);
  await runCommand(['git', 'init', '--quiet'], { cwd: workspace });
  await fs.writeFile(path.join(workspace, '.gitignore'), 'scratch/\n');
  const nested = path.join(workspace, 'scratch');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'code.py'), 'print(1)\n');
  await assert.rejects(snapshot(nested, path.join(dir, 'ignored-copy'), config), /No project files were captured/);
});

test('busy workspace, cancellation, and subsequent new task', async t => {
  const model = await mockModel(t, async () => { await new Promise(r => setTimeout(r, 2000)); return { content: 'done' }; });
  const { config, task } = await fixture(t, { baseUrl: model.url });
  const submitted = await submitTask(config, task);
  await assert.rejects(submitTask(config, { ...task, request_id: 'other' }), /Workspace busy/);
  const requested = cancelTask(config, submitted.task_id);
  assert.equal(requested.cancellation_requested, true);
  assert.equal((await waitDone(config, submitted.task_id)).status, 'cancelled');
  const next = await submitTask(config, { ...task, request_id: 'next' });
  cancelTask(config, next.task_id);
  assert.equal((await waitDone(config, next.task_id)).status, 'cancelled');
});

test('request timeout fails explicitly and preserves usage/status', async t => {
  const model = await mockModel(t, async () => { await new Promise(r => setTimeout(r, 2000)); return { content: 'done' }; });
  const { config, task } = await fixture(t, { baseUrl: model.url, requestTimeoutSeconds: 1 });
  const submitted = await submitTask(config, task);
  const done = await waitDone(config, submitted.task_id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /timeout/i);
});

test('turn budget exhaustion is a failure; checks cannot be silently skipped', async t => {
  const model = await mockModel(t, () => ({ content: 'Done.' }));
  const { config, task } = await fixture(t, { baseUrl: model.url, maxTurns: 1 });
  const submitted = await submitTask(config, { ...task, check_names: [] });
  const done = await waitDone(config, submitted.task_id);
  assert.equal(done.status, 'needs_primary');
  assert.equal(done.handoff.reason, 'turn_limit');
  assert.match(done.error, /Maximum 1/);
  assert.equal(done.checks[0].passed, false);
});

test('configured check timeout and cancellation stop execution', async t => {
  const { workspace } = await fixture(t);
  const argv = [process.execPath, '-e', 'setTimeout(() => {}, 10000)'];
  const timed = await runCommand(argv, { cwd: workspace, timeoutMs: 50 });
  assert.equal(timed.timed_out, true);
  const control = new AbortController();
  const pending = runCommand(argv, { cwd: workspace, signal: control.signal });
  setTimeout(() => control.abort(new Error('cancel check')), 50);
  await assert.rejects(pending, /cancel check/);
});

test('no configured checks is explicitly reported as unverified', async t => {
  const model = await mockModel(t, () => ({ content: 'Nothing changed.' }));
  const { config, task } = await fixture(t, { baseUrl: model.url, checks: {}, defaultChecks: [], requireChecks: false });
  const submitted = await submitTask(config, task);
  const done = await waitDone(config, submitted.task_id);
  assert.equal(done.status, 'ready_for_review');
  assert.equal(done.verification, 'not_run');
  assert.match(done.warnings[0], /UNVERIFIED/);
  assert.deepEqual(JSON.parse(readArtifact(config, done.task_id, 'checks').content), []);
});

test('tasks without checks are rejected by default before spending model tokens', async t => {
  const model = await mockModel(t, () => ({ content: 'done' }));
  const { config, task } = await fixture(t, { baseUrl: model.url, checks: {}, defaultChecks: [] });
  await assert.rejects(submitTask(config, task), /No checks selected/);
  assert.equal(model.requests.length, 0);
});

test('tool-driven failed repairs stop at two attempts with a usable handoff', async t => {
  const model = await mockModel(t, (_, n) => {
    if ([1, 3, 5].includes(n)) return call('run_check', { name: 'unit' });
    if (n === 2) return call('replace_text', { path: 'src/math.cjs', old_text: 'a - b', new_text: 'a * b' });
    if (n === 4) return call('replace_text', { path: 'src/math.cjs', old_text: 'a * b', new_text: 'a / b' });
    throw new Error('Unexpected additional model call after repair budget');
  });
  const { config, task, workspace } = await fixture(t, { baseUrl: model.url });
  const job = await submitTask(config, task);
  const done = await waitDone(config, job.task_id);
  assert.equal(done.status, 'needs_primary', JSON.stringify(done));
  assert.equal(done.handoff.reason, 'repair_limit');
  assert.equal(done.repair_attempts, 2);
  assert.deepEqual(done.failed_checks, ['unit']);
  assert.equal(model.requests.length, 5);
  assert.ok(done.artifacts.patch);
  assert.match(readArtifact(config, done.task_id, 'patch').content, /a \/ b/);
  assert.match(await fs.readFile(path.join(workspace, 'src/math.cjs'), 'utf8'), /a - b/);
});

test('zero repair allowance hands off on the first independent check failure', async t => {
  const model = await mockModel(t, () => ({ content: 'Done.' }));
  const { config, task } = await fixture(t, { baseUrl: model.url, maxRepairAttempts: 0 });
  const job = await submitTask(config, task);
  const done = await waitDone(config, job.task_id);
  assert.equal(done.status, 'needs_primary');
  assert.equal(done.handoff.reason, 'repair_limit');
  assert.equal(done.repair_attempts, 0);
  assert.equal(model.requests.length, 1);
});

test('requests to one endpoint are serialized across projects and state directories', async t => {
  let active = 0, peak = 0;
  const model = await mockModel(t, async () => {
    peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, 600));
    active--;
    return { content: 'Draft.' };
  });
  const a = await fixture(t, { baseUrl: model.url, checks: {}, defaultChecks: [], requireChecks: false });
  const b = await fixture(t, { baseUrl: model.url, checks: {}, defaultChecks: [], requireChecks: false });
  const submitted = await Promise.all([submitTask(a.config, a.task), submitTask(b.config, b.task)]);
  const done = await Promise.all([waitDone(a.config, submitted[0].task_id), waitDone(b.config, submitted[1].task_id)]);
  assert.ok(done.every(j => j.status === 'ready_for_review'), JSON.stringify(done));
  assert.equal(peak, 1);
  assert.equal(model.requests.length, 2);
  assert.ok(done.some(j => j.usage.queue_seconds > 0.3));
});

test('cancel while waiting for endpoint never sends the queued request', async t => {
  let started;
  const observed = new Promise(r => { started = r; });
  const model = await mockModel(t, async () => {
    started();
    await new Promise(r => setTimeout(r, 2000));
    return { content: 'Draft.' };
  });
  const a = await fixture(t, { baseUrl: model.url, checks: {}, defaultChecks: [], requireChecks: false });
  const b = await fixture(t, { baseUrl: model.url, checks: {}, defaultChecks: [], requireChecks: false });
  const first = await submitTask(a.config, a.task);
  await observed;
  const second = await submitTask(b.config, b.task);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const state = await getTask(b.config, second.task_id);
    if (state.stage === 'waiting_for_endpoint') break;
    await new Promise(r => setTimeout(r, 30));
  }
  cancelTask(b.config, second.task_id);
  assert.equal((await waitDone(b.config, second.task_id)).status, 'cancelled');
  assert.equal(model.requests.length, 1);
  cancelTask(a.config, first.task_id);
});

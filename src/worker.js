import fs from 'node:fs';
import path from 'node:path';
import { readJSON, atomicJSON, now } from './jobs.js';
import { snapshot, diffArtifacts } from './workspace.js';
import { runAgent } from './agent.js';
import { HandoffError } from './handoff.js';

const dir = process.argv[2];
let job = readJSON(path.join(dir, 'job.json'));
const { config, task } = job;
const root = path.join(dir, 'workspace');
const started = performance.now();
const controller = new AbortController();
let cancelled = false;
const save = async patch => {
  job = { ...job, ...patch, updated_at: now() };
  atomicJSON(path.join(dir, 'job.json'), job);
};
const event = async data => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ time: now(), ...data }) + '\n', { mode: 0o600 });
const records = [];
const onCheck = async record => {
  records.push(record);
  atomicJSON(path.join(dir, 'checks.json'), records);
  const recent = new Map();
  for (const r of records) recent.set(r.name, { name: r.name, passed: r.passed, final: r.final, exit_code: r.exit_code, timed_out: r.timed_out });
  await save({ checks: [...recent.values()] });
};
const abortCancelled = () => { cancelled = true; controller.abort(new Error('Task cancelled.')); };
const cancellationTimer = setInterval(() => { if (fs.existsSync(path.join(dir, 'cancel'))) abortCancelled(); }, 200);
const timeout = setTimeout(() => controller.abort(new Error(`Task exceeded ${config.maxTaskSeconds} seconds.`)), config.maxTaskSeconds * 1000);
process.on('SIGTERM', abortCancelled);
process.on('SIGINT', abortCancelled);

try {
  await save({ pid: process.pid, status: 'running', stage: 'snapshot' });
  if (fs.existsSync(path.join(dir, 'cancel'))) abortCancelled();
  controller.signal.throwIfAborted();
  const info = await snapshot(task.workspace, root, config, controller.signal);
  await save({ snapshot: info });
  await event({ type: 'snapshot', files: info.files, bytes: info.bytes });
  const result = await runAgent({ config, task, root, signal: controller.signal, update: save, event, onCheck });
  controller.signal.throwIfAborted();
  fs.writeFileSync(path.join(dir, 'changes.patch'), result.patch, { mode: 0o600 });
  delete result.patch;
  await save({ ...result, status: 'ready_for_review', stage: 'finished', elapsed_seconds: (performance.now() - started) / 1000,
    artifacts: { patch: path.join(dir, 'changes.patch'), checks: path.join(dir, 'checks.json') } });
} catch (error) {
  const status = cancelled ? 'cancelled' : error instanceof HandoffError ? 'needs_primary' : 'failed';
  try {
    if (fs.existsSync(path.join(root, '.git'))) {
      const result = await diffArtifacts(root, task, config);
      fs.writeFileSync(path.join(dir, 'changes.patch'), result.patch, { mode: 0o600 });
      job.changed_files = result.changed_files;
      job.artifacts = { patch: path.join(dir, 'changes.patch'), checks: path.join(dir, 'checks.json') };
    }
  } catch { /* preserve original failure */ }
  await save({ status, stage: 'finished', verification: 'incomplete', elapsed_seconds: (performance.now() - started) / 1000,
    handoff: cancelled ? null : { recommended: true, reason: error.reason || (controller.signal.aborted ? 'task_timeout' : 'execution_error'),
      action: 'Read the failed check summary and partial patch, then have the primary model finish or split the task. Do not automatically resubmit the same task.' },
    error: controller.signal.aborted ? controller.signal.reason.message : error.message });
  await event({ type: status, error: job.error });
} finally {
  if (!fs.existsSync(path.join(dir, 'checks.json'))) atomicJSON(path.join(dir, 'checks.json'), records);
  clearInterval(cancellationTimer);
  clearTimeout(timeout);
}

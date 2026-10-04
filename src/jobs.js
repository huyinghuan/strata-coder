import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { taskSchema, cleanRelative, within } from './config.js';

export const terminal = new Set(['ready_for_review', 'needs_primary', 'failed', 'cancelled', 'interrupted']);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
export const now = () => new Date().toISOString();
export function atomicJSON(filename, value) {
  const tmp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filename);
}
export const readJSON = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
export function jobDir(config, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid task ID.');
  return path.join(config.stateDir, 'jobs', id);
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function readJob(config, id) {
  const dir = jobDir(config, id);
  const job = readJSON(path.join(dir, 'job.json'));
  if (!terminal.has(job.status)) {
    let pid = job.pid;
    try { pid ||= readJSON(path.join(dir, 'process.json')).pid; } catch { /* starting */ }
    if (!alive(pid) && Date.now() - Date.parse(job.created_at) > 15000) {
      job.status = 'interrupted';
      job.error = 'Worker exited before completion. Inspect artifacts and submit a new request ID.';
      job.handoff = { recommended: true, reason: 'worker_interrupted', action: 'Review partial artifacts and continue with the primary model or submit a smaller task.' };
      job.updated_at = now();
      atomicJSON(path.join(dir, 'job.json'), job);
    }
  }
  return job;
}

export function publicJob(job) {
  const { pid, fingerprint, config, task, ...rest } = job;
  return { ...rest, suggested_poll_seconds: terminal.has(job.status) ? 0 : 10 };
}

function assertInScope(job, scope) {
  if (scope && !scope.allowsSync(job.task.workspace)) {
    throw new Error('Task workspace is outside this connection roots: ' + job.task.workspace);
  }
}

function releaseStaleLock(config, lock) {
  try {
    const owner = readJSON(lock);
    const previous = readJob(config, owner.task_id);
    if (terminal.has(previous.status)) { fs.unlinkSync(lock); return; }
    throw new Error(`Workspace busy; existing task_id=${owner.task_id}. Query it instead of resubmitting.`);
  } catch (e) {
    // Caller holds the short-lived interprocess submission guard: an orphan
    // reservation cannot belong to another submission still creating its job.
    if (e.code === 'ENOENT') { if (fs.existsSync(lock)) fs.unlinkSync(lock); return; }
    throw e;
  }
}

export async function submitTask(config, input, scope = null) {
  const task = taskSchema.parse(input);
  if (scope) {
    task.workspace = await scope.resolveTaskWorkspace(task.workspace);
  } else if (!task.workspace) {
    throw new Error('workspace is required when no host workspace scope is available.');
  }
  if (!path.isAbsolute(task.workspace)) throw new Error('workspace must be an absolute path.');
  task.workspace = fs.realpathSync(task.workspace);
  if (!fs.statSync(task.workspace).isDirectory()) throw new Error('workspace must be a directory.');
  if (within(config.stateDir, task.workspace)) throw new Error('Cannot use the worker state directory as a workspace.');
  task.allowed_paths = task.allowed_paths.map(cleanRelative);
  task.check_names = [...new Set([...config.defaultChecks, ...(task.check_names || [])])];
  for (const name of task.check_names) if (!Object.hasOwn(config.checks, name)) throw new Error(`Unknown check: ${name}`);
  if (config.requireChecks && !task.check_names.length) {
    throw new Error('No checks selected. Configure a real project check and select check_names/defaultChecks, or let the primary model handle this task. Unverified drafts require an explicit requireChecks:false configuration.');
  }
  const id = hash(`${task.workspace}\0${task.request_id}`).slice(0, 32);
  const dir = jobDir(config, id);
  const { configPath, ...executionConfig } = config;
  const fingerprint = hash(JSON.stringify({ task, config: executionConfig }));
  const locks = path.join(config.stateDir, 'locks');
  fs.mkdirSync(locks, { recursive: true });
  const lock = path.join(locks, hash(task.workspace) + '.json');
  const release = await lockfile.lock(lock, { realpath: false, stale: 10000, update: 2000,
    retries: { retries: 60, minTimeout: 100, maxTimeout: 250 } });
  try { return await submitLocked(config, task, id, dir, fingerprint, lock); }
  finally { await release(); }
}

async function submitLocked(config, task, id, dir, fingerprint, lock) {
  if (fs.existsSync(path.join(dir, 'job.json'))) {
    const previous = readJob(config, id);
    if (previous.fingerprint !== fingerprint) throw new Error('request_id was already used with different arguments or model/check configuration.');
    return publicJob(previous);
  }
  releaseStaleLock(config, lock);
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ task_id: id }));
  fs.closeSync(fd);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicJSON(path.join(dir, 'job.json'), {
      task_id: id, status: 'queued', stage: 'starting', created_at: now(), updated_at: now(),
      workspace: task.workspace, model: config.model, task, config, fingerprint,
      iterations: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 },
      repair_attempts: 0, verification: 'pending',
      checks: [], summary: null, changed_files: [],
    });
    atomicJSON(path.join(dir, 'checks.json'), []);
    const log = fs.openSync(path.join(dir, 'worker.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), dir], {
        detached: true, stdio: ['ignore', log, log], env: process.env,
      });
    } finally { fs.closeSync(log); }
    await once(child, 'spawn');
    atomicJSON(path.join(dir, 'process.json'), { pid: child.pid });
    child.unref();
    return publicJob(readJob(config, id));
  } catch (error) {
    if (fs.existsSync(path.join(dir, 'job.json'))) {
      const job = readJSON(path.join(dir, 'job.json'));
      atomicJSON(path.join(dir, 'job.json'), { ...job, status: 'failed', error: error.message });
    }
    try { fs.unlinkSync(lock); } catch { /* no lock */ }
    throw error;
  }
}

export async function getTask(config, id, waitSeconds = 0, scope = null) {
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 25) * 1000;
  let job;
  do {
    job = readJob(config, id);
    assertInScope(job, scope);
    if (terminal.has(job.status) || Date.now() >= deadline) return publicJob(job);
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
}

export function cancelTask(config, id, scope = null) {
  const job = readJob(config, id);
  assertInScope(job, scope);
  if (terminal.has(job.status)) return publicJob(job);
  fs.writeFileSync(path.join(jobDir(config, id), 'cancel'), now(), { mode: 0o600 });
  return { task_id: id, status: job.status, cancellation_requested: true };
}

export function readArtifact(config, id, artifact, offset = 0, limit = 12000, scope = null) {
  const names = { patch: 'changes.patch', checks: 'checks.json', events: 'events.jsonl' };
  if (!Object.hasOwn(names, artifact)) throw new Error('artifact must be patch, checks, or events.');
  const job = readJob(config, id);
  assertInScope(job, scope);
  if (artifact === 'patch' && !terminal.has(job.status)) throw new Error('Patch is available after the task stops.');
  const file = path.join(jobDir(config, id), names[artifact]);
  if (!fs.existsSync(file)) throw new Error('Artifact is not yet available.');
  offset = Math.max(0, Math.trunc(offset)); limit = Math.min(24000, Math.max(1, Math.trunc(limit)));
  const content = fs.readFileSync(file, 'utf8');
  return { task_id: id, artifact, offset, content: content.slice(offset, offset + limit),
    next_offset: offset + limit < content.length ? offset + limit : null, total_chars: content.length };
}

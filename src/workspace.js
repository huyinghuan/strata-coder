import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanRelative, within, allowedFile } from './config.js';
import { executionEnv } from './process.js';

const exec = promisify(execFile);
const ignoredParts = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.local-coder-state', '.aws', '.ssh', '.codex', '.agents']);
export function excluded(relative, config) {
  const parts = relative.split('/');
  return parts.some(p => ignoredParts.has(p) || /^\.env(?:\.|$)/.test(p) || /\.(pem|key)$/i.test(p)) ||
    config.exclude.some(p => relative === p || relative.startsWith(`${p}/`));
}

export async function safePath(root, relative, config) {
  relative = cleanRelative(relative);
  if (excluded(relative, config)) throw new Error(`Excluded path: ${relative}`);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${relative}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!within(root, current)) throw new Error('Path outside workspace.');
  return current;
}

async function git(root, args, maxBuffer = 64 * 1024 * 1024) {
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], {
    cwd: root, env: executionEnv(), maxBuffer, timeout: 30000, encoding: 'utf8',
  })).stdout;
}

async function walk(root, config, prefix = '', result = []) {
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (excluded(rel, config) || within(config.stateDir, path.join(root, rel))) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(root, config, rel, result);
    else if (entry.isFile()) result.push(rel);
    if (result.length > config.maxSnapshotFiles) throw new Error('Too many project files; narrow workspace or configure exclude.');
  }
  return result;
}

export async function snapshot(source, destination, config, signal) {
  await fs.mkdir(destination, { recursive: true });
  let files;
  try { files = (await git(source, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean); }
  catch { files = await walk(source, config); }
  files = [...new Set(files)];
  let bytes = 0, count = 0;
  const skipped = [];
  for (const rel of files) {
    signal?.throwIfAborted();
    if (excluded(rel, config) || within(config.stateDir, path.join(source, rel))) { skipped.push(rel); continue; }
    let input;
    try { input = await safePath(source, rel, config); }
    catch (error) { skipped.push(rel); continue; }
    let stat;
    try { stat = await fs.stat(input); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!stat.isFile()) { skipped.push(rel); continue; }
    bytes += stat.size; count++;
    if (count > config.maxSnapshotFiles || bytes > config.maxSnapshotBytes) throw new Error('Snapshot limit exceeded; configure exclude or use a smaller workspace.');
    const output = path.join(destination, rel);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(input, output);
    await fs.chmod(output, stat.mode & 0o777);
  }
  if (count === 0 && (await walk(source, config)).length > 0) {
    throw new Error('No project files were captured although readable source files exist. The workspace may be excluded by parent Git ignore rules; choose a project root or move it outside the ignored directory.');
  }
  await git(destination, ['init', '--quiet']);
  await git(destination, ['add', '--force', '--all']);
  await git(destination, ['-c', 'user.name=Local Coder', '-c', 'user.email=local-coder@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Task input snapshot']);
  return { files: count, bytes, skipped_count: skipped.length, skipped: skipped.slice(0, 30) };
}

export async function listFiles(root, config) { return walk(root, config); }

export async function diffArtifacts(root, task, config) {
  // Force-add includes newly created files even if the model changed .gitignore.
  const files = await walk(root, config);
  for (let i = 0; i < files.length; i += 100) await git(root, ['add', '--force', '--', ...files.slice(i, i + 100)]);
  await git(root, ['add', '-u']);
  const changed = (await git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD'])).split('\0').filter(Boolean);
  const outOfScope = changed.filter(p => excluded(p, config) || !allowedFile(p, task.allowed_paths));
  return {
    changed_files: changed,
    out_of_scope: outOfScope,
    patch: await git(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', 'HEAD']),
    diff_stat: await git(root, ['diff', '--cached', '--stat', 'HEAD']),
  };
}

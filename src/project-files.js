import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * sha256 hex digest of a UTF-8 string.
 * @param {string} text
 * @returns {string}
 */
export function hashContent(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Write `content` to `filename` atomically.
 *
 * The parent directory is created recursively. Content is written to a
 * temporary file in the same directory, the mode is applied to that temporary
 * file, and only then is it renamed over the target. On any failure the
 * temporary file is removed before the error is rethrown; on success no
 * temporary file is left behind.
 *
 * @param {string} filename
 * @param {string} content
 * @param {number} [mode=0o644]
 * @returns {Promise<string>} absolute path of the written file
 */
export async function atomicWriteFile(filename, content, mode = 0o644) {
  const target = path.resolve(filename);
  const dir = path.dirname(target);
  const tmp = path.join(
    dir,
    `${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, content, 'utf8');
    // The mode must be applied to the temporary file before the rename, so the
    // target never exists with a different mode than requested.
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }

  return target;
}

/**
 * Copy `file` into `backupDir` under a timestamped flattened name.
 *
 * Returns the absolute backup path, or null when `file` does not exist.
 * Repeated backups never overwrite each other.
 *
 * @param {string} file
 * @param {string} backupDir
 * @returns {Promise<string|null>}
 */
export async function backupFile(file, backupDir) {
  const source = path.resolve(file);
  let stat;
  try {
    stat = await fs.stat(source);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) return null;

  await fs.mkdir(backupDir, { recursive: true });

  // Flatten the name: basename only, never directory separators.
  const flat = path.basename(source).replace(/[\\/]/g, '_');
  let name = `${flat}.${Date.now()}.bak`;
  let dest = path.join(backupDir, name);
  let attempt = 1;
  while (await exists(dest)) {
    name = `${flat}.${Date.now()}-${attempt++}.bak`;
    dest = path.join(backupDir, name);
  }

  await fs.copyFile(source, dest);
  return dest;
}

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Insert or replace a managed block delimited by full marker lines.
 *
 * `block` is the complete replacement text including both marker lines.
 *
 * @param {string} text
 * @param {{ start: string, end: string, block: string, eol?: string }} options
 * @returns {{ changed: boolean, text: string, error?: string }}
 */
export function upsertManagedBlock(text, options = {}) {
  const { start, end, block } = options;
  const source = String(text ?? '');
  const eol = options.eol || (source.includes('\r\n') ? '\r\n' : '\n');

  const lines = splitLines(source);
  const startIndex = lines.findIndex((line) => line === start);
  const endIndex = lines.findIndex((line) => line === end);

  if (startIndex === -1 && endIndex === -1) {
    const bl = blockLines(block);
    if (source.trim().length === 0) {
      return { changed: true, text: bl.join(eol) + eol };
    }
    const bodyLines = splitLines(source);
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
    const out = [bodyLines.join(eol).replace(/\s+$/, ''), '', bl.join(eol)];
    return { changed: true, text: out.join(eol) + eol };
  }

  if (startIndex === -1 || endIndex === -1) {
    return { changed: false, text: source, error: 'unbalanced markers' };
  }

  if (endIndex < startIndex) {
    return { changed: false, text: source, error: 'unbalanced markers' };
  }

  const bl = blockLines(block);
  const before = lines.slice(0, startIndex);
  const after = lines.slice(endIndex + 1);
  const result = joinLines([...before, ...bl, ...after], eol);

  if (result === source) return { changed: false, text: source };
  return { changed: true, text: result };
}

function splitLines(text) {
  return String(text).split(/\r\n|\r|\n/);
}

function blockLines(text) {
  const lines = splitLines(String(text ?? ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function joinLines(lines, eol) {
  return lines.join(eol);
}

/**
 * Decide what to do with a managed file given its current content and the
 * hash recorded when the block was last written.
 *
 * @param {{ existingText: string|undefined, desiredText: string, recordedHash?: string|null }} options
 * @returns {{ action: 'create'|'unchanged'|'update'|'skip-modified', text: string }}
 */
export function managedFileAction({ existingText, desiredText, recordedHash }) {
  if (existingText === undefined) {
    return { action: 'create', text: desiredText };
  }
  if (existingText === desiredText) {
    return { action: 'unchanged', text: existingText };
  }
  if (typeof recordedHash === 'string' && hashContent(existingText) === recordedHash) {
    return { action: 'update', text: desiredText };
  }
  return { action: 'skip-modified', text: existingText };
}

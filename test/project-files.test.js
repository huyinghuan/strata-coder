import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  atomicWriteFile,
  backupFile,
  hashContent,
  managedFileAction,
  upsertManagedBlock,
} from '../src/project-files.js';

async function tmpRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listNames(dir) {
  return (await fs.readdir(dir)).sort();
}

// A. atomicWriteFile
test('atomicWriteFile creates parent directories, writes exact content and mode', async (t) => {
  const root = await tmpRoot(t);
  const target = path.join(root, 'nested', 'deep', 'AGENTS.md');
  const written = await atomicWriteFile(target, '# hello\n', 0o600);

  assert.equal(written, target);
  assert.equal(await fs.readFile(target, 'utf8'), '# hello\n');
  const stat = await fs.stat(target);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(await listNames(path.dirname(target)), ['AGENTS.md']);
});

test('atomicWriteFile replaces an existing file and leaves no temporary files', async (t) => {
  const root = await tmpRoot(t);
  const target = path.join(root, 'config.json');
  await fs.writeFile(target, 'original\n');

  await atomicWriteFile(target, 'replacement\n', 0o644);
  assert.equal(await fs.readFile(target, 'utf8'), 'replacement\n');
  assert.deepEqual(await listNames(root), ['config.json']);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
});

test('atomicWriteFile removes the temporary file when the rename fails', async (t) => {
  const root = await tmpRoot(t);
  const target = path.join(root, 'blocked.txt');
  // A directory cannot be replaced by a rename, so the rename step fails.
  await fs.mkdir(target);

  await assert.rejects(() => atomicWriteFile(target, 'content\n'));
  assert.deepEqual(await listNames(root), ['blocked.txt']);
});

test('atomicWriteFile removes the temporary file when the write fails', async (t) => {
  const root = await tmpRoot(t);
  const dir = path.join(root, 'sub');
  const target = path.join(dir, 'file.txt');

  // An invalid content type fails during the write step.
  await assert.rejects(() => atomicWriteFile(target, { not: 'text' }, 0o644));
  assert.deepEqual(await listNames(dir), []);
});

// B. backupFile
test('backupFile returns null for a missing file', async (t) => {
  const root = await tmpRoot(t);
  const missing = path.join(root, 'nope.md');
  assert.equal(await backupFile(missing, path.join(root, 'backups')), null);
  assert.equal(await fs.stat(path.join(root, 'backups')).catch(() => null), null);
});

test('backupFile copies an existing file byte-for-byte into a new backupDir', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'AGENTS.md');
  const content = Buffer.from('# agent\r\nbytes\n');
  await fs.writeFile(file, content);

  const backupDir = path.join(root, 'backups', 'nested');
  const backup = await backupFile(file, backupDir);
  assert.ok(path.isAbsolute(backup));
  assert.equal(path.dirname(backup), backupDir);
  assert.match(path.basename(backup), /^AGENTS\.md\.\d+(-\d+)?\.bak$/);
  assert.ok(!path.basename(backup).includes(path.sep));
  assert.deepEqual(await fs.readFile(backup), content);
  assert.deepEqual(await listNames(backupDir), [path.basename(backup)]);
});

test('backupFile produces distinct files for repeated calls', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'AGENTS.md');
  await fs.writeFile(file, 'first\n');

  const first = await backupFile(file, path.join(root, 'backups'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.writeFile(file, 'second\n');
  const second = await backupFile(file, path.join(root, 'backups'));

  assert.notEqual(first, second);
  const names = await listNames(path.join(root, 'backups'));
  assert.equal(names.length, 2);
  assert.equal(await fs.readFile(first, 'utf8'), 'first\n');
  assert.equal(await fs.readFile(second, 'utf8'), 'second\n');
});

// C. appending blocks
test('upsertManagedBlock appends to empty text with one trailing newline', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const block = `${start}\nbody\n${end}`;
  const result = upsertManagedBlock('', { start, end, block });

  assert.equal(result.changed, true);
  assert.equal(result.text, `${start}\nbody\n${end}\n`);
});

test('upsertManagedBlock appends to text without markers, separated by a blank line', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const block = `${start}\nmanaged\n${end}`;
  const result = upsertManagedBlock('existing content\nmore\n', { start, end, block });

  assert.equal(result.changed, true);
  assert.equal(result.text, `existing content\nmore\n\n${block}\n`);
  assert.ok(result.text.endsWith('\n'));
  assert.ok(!result.text.endsWith('\n\n'));
});

test('upsertManagedBlock treats whitespace-only text as empty', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const block = `${start}\nmanaged\n${end}`;
  const result = upsertManagedBlock('   \n\n  ', { start, end, block });
  assert.equal(result.text, `${block}\n`);
});

test('upsertManagedBlock does not double the trailing newline when the block ends with one', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const result = upsertManagedBlock('keep\n', { start, end, block: `${start}\nbody\n${end}\n` });
  assert.equal(result.text, `keep\n\n${start}\nbody\n${end}\n`);
});

// D. replacing an existing block, preserving surrounding content
test('upsertManagedBlock replaces an existing managed block and is idempotent', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const original = `header line\n${start}\nold body\n${end}\nfooter line\n`;
  const block = `${start}\nnew body\n${end}`;

  const first = upsertManagedBlock(original, { start, end, block });
  assert.equal(first.changed, true);
  assert.equal(first.text, `header line\n${block}\nfooter line\n`);

  const second = upsertManagedBlock(first.text, { start, end, block });
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('upsertManagedBlock preserves leading and trailing content around the block', () => {
  const start = '<!-- strata-coder:start -->';
  const end = '<!-- strata-coder:end -->';
  const original = `line one\n\n${start}\nold\n${end}\n\nlast line`;
  const block = `${start}\nnew\n${end}`;
  const result = upsertManagedBlock(original, { start, end, block });
  assert.equal(result.text, `line one\n\n${block}\n\nlast line`);
});

// E. marker styles
test('upsertManagedBlock keeps # markers working for gitignore-style files', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const block = `${start}\n/state/\n${end}`;
  const result = upsertManagedBlock('.env\n', { start, end, block });
  assert.equal(result.text, `.env\n\n${block}\n`);

  const again = upsertManagedBlock(result.text, { start, end, block });
  assert.equal(again.changed, false);
});

test('upsertManagedBlock keeps HTML comment markers working for markdown', () => {
  const start = '<!-- strata-coder:start -->';
  const end = '<!-- strata-coder:end -->';
  const block = `${start}\n## Rules\n${end}`;
  const original = `# Title\n${start}\nold\n${end}\n\nEnd.\n`;
  const result = upsertManagedBlock(original, { start, end, block });
  assert.equal(result.text, `# Title\n${block}\n\nEnd.\n`);
});

test('marker text inside a line is not treated as a marker line', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const block = `${start}\nnew\n${end}`;
  const original = `see ${start} docs\n${start}\nold\n${end}\n`;
  const result = upsertManagedBlock(original, { start, end, block });
  assert.equal(result.text, `see ${start} docs\n${block}\n`);
});

// F. unbalanced markers
test('upsertManagedBlock reports unbalanced markers and changes nothing', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const block = `${start}\nnew\n${end}`;

  const onlyStart = 'text\n' + start + '\nbody\n';
  const r1 = upsertManagedBlock(onlyStart, { start, end, block });
  assert.equal(r1.changed, false);
  assert.equal(r1.text, onlyStart);
  assert.equal(r1.error, 'unbalanced markers');

  const onlyEnd = 'text\n' + end + '\nbody\n';
  const r2 = upsertManagedBlock(onlyEnd, { start, end, block });
  assert.equal(r2.changed, false);
  assert.equal(r2.text, onlyEnd);
  assert.equal(r2.error, 'unbalanced markers');
});

// G. line endings
test('upsertManagedBlock detects CRLF input', () => {
  const start = '# strata-coder:start';
  const end = '# strata-coder:end';
  const block = `${start}\nnew\n${end}`;
  const original = `first\r\n${start}\r\nold\r\n${end}\r\nlast\r\n`;
  const result = upsertManagedBlock(original, { start, end, block });
  assert.equal(result.text, `first\r\n${start}\r\nnew\r\n${end}\r\nlast\r\n`);
  assert.ok(result.text.includes('\r\n'));

  const appended = upsertManagedBlock('plain\r\n', { start, end, block });
  assert.equal(appended.text, `plain\r\n\r\n${start}\r\nnew\r\n${end}\r\n`);
});

test('upsertManagedBlock respects an explicit eol', () => {
  const start = '<!-- strata-coder:start -->';
  const end = '<!-- strata-coder:end -->';
  const block = `${start}\nnew\n${end}`;
  const result = upsertManagedBlock('a\nb\n', { start, end, block, eol: '\r\n' });
  assert.equal(result.text, `a\r\nb\r\n\r\n${start}\r\nnew\r\n${end}\r\n`);

  const replaced = upsertManagedBlock(`a\r\n${start}\r\nold\r\n${end}\r\nb\r\n`, {
    start,
    end,
    block,
    eol: '\n',
  });
  assert.equal(replaced.text, `a\n${block}\nb\n`);
});

// H. managedFileAction
test('managedFileAction creates when the file is absent', () => {
  const desired = 'desired\n';
  assert.deepEqual(managedFileAction({ existingText: undefined, desiredText: desired }), {
    action: 'create',
    text: desired,
  });
});

test('managedFileAction reports unchanged for identical text', () => {
  const desired = 'same\n';
  assert.deepEqual(managedFileAction({ existingText: desired, desiredText: desired }), {
    action: 'unchanged',
    text: desired,
  });
  // Identical text is unchanged even when a hash is recorded.
  assert.deepEqual(
    managedFileAction({ existingText: desired, desiredText: desired, recordedHash: hashContent('other') }),
    { action: 'unchanged', text: desired },
  );
});

test('managedFileAction updates when the recorded hash matches', () => {
  const existing = 'managed\n';
  const desired = 'managed updated\n';
  const recorded = hashContent(existing);
  assert.equal(hashContent(existing), recorded);
  assert.deepEqual(managedFileAction({ existingText: existing, desiredText: desired, recordedHash: recorded }), {
    action: 'update',
    text: desired,
  });
});

test('managedFileAction skips modified files with a wrong or missing hash', () => {
  const existing = 'user edited\n';
  const desired = 'desired\n';

  assert.deepEqual(
    managedFileAction({ existingText: existing, desiredText: desired, recordedHash: hashContent('other') }),
    { action: 'skip-modified', text: existing },
  );
  assert.deepEqual(managedFileAction({ existingText: existing, desiredText: desired }), {
    action: 'skip-modified',
    text: existing,
  });
  assert.deepEqual(
    managedFileAction({ existingText: existing, desiredText: desired, recordedHash: null }),
    { action: 'skip-modified', text: existing },
  );
});

test('hashContent is sha256 hex of the UTF-8 text', () => {
  assert.equal(hashContent(''), hashContent(''));
  assert.match(hashContent('abc'), /^[0-9a-f]{64}$/);
  assert.equal(hashContent('abc'), hashContent('abc'));
  assert.notEqual(hashContent('abc'), hashContent('abd'));
  assert.equal(hashContent('é'), hashContent(Buffer.from('é', 'utf8').toString('utf8')));
});

// Shared black-box helpers for the `strata-coder init` CLI tests.
//
// Nothing here imports functions from src/init.js: the tests only spawn the
// real CLI through process.execPath and inspect the files it writes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';

export const initPath = fileURLToPath(new URL('../src/init.js', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// Run the CLI in non-interactive mode. `--yes` is always added so no TTY
// questions are ever asked.
export function runInit({ project, args = [], env = {}, opencodeBin = null }) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    if (opencodeBin) {
      childEnv.PATH = [opencodeBin, childEnv.PATH ?? ''].join(path.delimiter);
    }

    const child = spawn(process.execPath, [initPath, '--yes', '--cwd', project, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

// Create a throwaway project directory with a package.json and (optionally) a
// minimal zero-dependency lock file.
export async function makeProject(t, { name = 'project', testScript, lock = true, packageJson } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'strata-init-project-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const root = path.join(tmp, name);
  await fsp.mkdir(root, { recursive: true });

  const pkg = packageJson ?? {
    name: 'demo',
    version: '1.0.0',
    scripts: { test: testScript ?? 'node -e "process.exit(0)"' },
  };
  await fsp.writeFile(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  if (lock) {
    const lockfile = {
      lockfileVersion: 3,
      packages: { '': { name: 'demo', version: '1.0.0' } },
    };
    await fsp.writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify(lockfile, null, 2)}\n`);
  }

  return { tmp, root };
}

// A fake `opencode` executable that only prints its version, so init can decide
// it is talking to OpenCode 2.x without a real installation.
export async function makeFakeOpenCode(t, version = 'opencode v2.0.22') {
  const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'strata-init-opencode-'));
  t.after(() => fsp.rm(bin, { recursive: true, force: true }));

  const script = path.join(bin, 'opencode');
  await fsp.writeFile(script, `#!/bin/sh\necho '${version}'\n`);
  await fsp.chmod(script, 0o755);

  return bin;
}

export function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// JSON, and JSONC with comments, both parse here.
export async function readJson(file) {
  return parseJsonc(await fsp.readFile(file, 'utf8'));
}

// sha256 of every file under root, keyed by relative POSIX path. node_modules
// and the state directory are excluded because the MCP server may touch them.
export async function snapshotHashes(root) {
  const hashes = {};

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        if (rel === '.strata-coder/state') continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const text = await fsp.readFile(full);
      hashes[rel] = crypto.createHash('sha256').update(text).digest('hex');
    }
  }

  await walk(root);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Every readable file under root (node_modules skipped), as { path, text }.
export async function listFiles(root, { skipNodeModules = true } = {}) {
  const files = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (skipNodeModules && entry.name === 'node_modules') continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ path: rel, text: await fsp.readFile(full, 'utf8') });
    }
  }

  await walk(root);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

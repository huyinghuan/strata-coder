import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../src/npm-check.js', import.meta.url));

async function tempDir(t, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Runs the helper in `cwd` (the project copy root) and collects output.
function runHelper(cwd, argv, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, ...argv], {
      cwd, env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const markerArgv = ['-e', 'console.log("MARKER_RAN")'];

test('missing test command after the -- separator exits 2 and reports usage', async t => {
  const cwd = await tempDir(t, 'npm-check-usage-');

  const noSeparator = await runHelper(cwd, []);
  assert.equal(noSeparator.code, 2);
  assert.match(noSeparator.stderr, /test command/);

  const emptyAfterSeparator = await runHelper(cwd, ['--']);
  assert.equal(emptyAfterSeparator.code, 2);
  assert.match(emptyAfterSeparator.stderr, /test command/);
});

test('no lock file exits 2 without running the test command', async t => {
  const cwd = await tempDir(t, 'npm-check-no-lock-');
  await fs.writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'no-lock-project', version: '1.0.0', type: 'module' })
  );

  const result = await runHelper(cwd, ['--', process.execPath, '-e', 'console.log("MARKER_SHOULD_NOT_RUN")']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /lock file/);
  assert.ok(!result.stdout.includes('MARKER_SHOULD_NOT_RUN'), 'the test command must not run');
  assert.ok(!result.stderr.includes('MARKER_SHOULD_NOT_RUN'), 'the test command must not run');
  // Nothing was installed and no project file was created or modified.
  assert.ok(!fsSync.existsSync(path.join(cwd, 'node_modules')));
  assert.ok(!fsSync.existsSync(path.join(cwd, 'package-lock.json')));
});

test('a minimal lock file prepares dependencies with npm ci --ignore-scripts and runs the test', async t => {
  const cwd = await tempDir(t, 'npm-check-lock-');
  await fs.writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'locked-project', version: '1.0.0', type: 'module' })
  );
  await fs.writeFile(
    path.join(cwd, 'package-lock.json'),
    JSON.stringify({ name: 'locked-project', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} })
  );
  const lockBefore = await fs.readFile(path.join(cwd, 'package-lock.json'), 'utf8');
  const packageJsonBefore = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');

  const result = await runHelper(cwd, ['--', process.execPath, ...markerArgv]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[strata-coder\] installing dependencies with npm ci --ignore-scripts/);
  assert.ok(result.stdout.includes('MARKER_RAN'), 'the test command must run after preparation');
  assert.equal(await fs.readFile(path.join(cwd, 'package-lock.json'), 'utf8'), lockBefore);
  assert.equal(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'), packageJsonBefore);
});

test('an existing node_modules directory does not excuse a missing lock file', async t => {
  const cwd = await tempDir(t, 'npm-check-skip-');
  await fs.writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'skip-project', version: '1.0.0', type: 'module' })
  );
  await fs.mkdir(path.join(cwd, 'node_modules'), { recursive: true });

  const result = await runHelper(cwd, ['--', process.execPath, ...markerArgv]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 2, result.stderr);
  assert.ok(!result.stdout.includes('MARKER_RAN'));
  assert.match(result.stderr, /lock file/);
  assert.ok(!fsSync.existsSync(path.join(cwd, 'package-lock.json')));
});

test('the test command exit code is propagated', async t => {
  const cwd = await tempDir(t, 'npm-check-exit-');
  await writeManifests(cwd);

  const result = await runHelper(cwd, [
    '--',
    process.execPath,
    '-e',
    'console.log("MARKER_RAN"); process.exit(3);',
  ]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 3);
  assert.ok(result.stdout.includes('MARKER_RAN'));
});

test('an unknown test command executable reports an accurate error and exits 127', async t => {
  const cwd = await tempDir(t, 'npm-check-notfound-');
  await writeManifests(cwd);

  const result = await runHelper(cwd, ['--', 'strata-coder-definitely-not-installed']);
  assert.equal(result.code, 127);
  assert.match(result.stderr, /strata-coder-definitely-not-installed/);
});

async function writeManifests(cwd) {
  await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'check-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'check-fixture', version: '1.0.0' } } }));
}

test('failed install is retried, successful installs are reused only while manifests match', async t => {
  const cwd = await tempDir(t, 'npm-check-retry-');
  await writeManifests(cwd);
  const bin = path.join(cwd, 'bin'); await fs.mkdir(bin);
  const fake = path.join(bin, 'npm');
  await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('attempts', 'install\\n');
fs.mkdirSync('node_modules', {recursive: true});
if (fs.existsSync('fail-install')) process.exit(1);
`);
  await fs.chmod(fake, 0o755);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const args = ['--', process.execPath, ...markerArgv];
  await fs.writeFile(path.join(cwd, 'fail-install'), '');
  for (let i = 0; i < 2; i++) {
    const failed = await runHelper(cwd, args, env);
    assert.equal(failed.code, 1);
    assert.ok(!failed.stdout.includes('MARKER_RAN'));
  }
  await fs.rm(path.join(cwd, 'fail-install'));
  assert.equal((await runHelper(cwd, args, env)).code, 0);
  const attempts = await fs.readFile(path.join(cwd, 'attempts'), 'utf8');
  assert.equal(attempts.trim().split('\n').length, 3);
  assert.equal((await runHelper(cwd, args, env)).code, 0);
  assert.equal(await fs.readFile(path.join(cwd, 'attempts'), 'utf8'), attempts);
  for (const file of ['package-lock.json', 'package.json']) {
    await fs.appendFile(path.join(cwd, file), ' ');
    const changed = await runHelper(cwd, args, env);
    assert.equal(changed.code, 0);
    assert.match(changed.stdout, /installing dependencies/);
  }
});

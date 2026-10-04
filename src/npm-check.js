#!/usr/bin/env node
// Standalone npm check helper shipped in the npm package.
//
// It is referenced from a generated project check command as:
//   [process.execPath, "<installed>/src/npm-check.js", "--", "npm", "test"]
// and runs inside the worker's project copy, so process.cwd() is the copy root.
//
// It installs locked dependencies in the task copy and caches a successful
// installation fingerprint under node_modules. Manifests are never rewritten.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INSTALL_TIMEOUT_MS = 240000;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 127;
const EXIT_KILLED = 1;

function usageError() {
  process.stderr.write(
    'usage: node src/npm-check.js -- <test command argv...>\n' +
      'The test command is read from the arguments after the first "--" separator.\n' +
      'Example: node src/npm-check.js -- npm test\n'
  );
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function dependencyFingerprint(cwd) {
  const lock = ['npm-shrinkwrap.json', 'package-lock.json'].find(name => fs.existsSync(path.join(cwd, name)));
  if (!lock) return null;
  const hash = crypto.createHash('sha256');
  for (const name of ['package.json', lock, '.npmrc']) {
    hash.update(name + '\0');
    try { hash.update(fs.readFileSync(path.join(cwd, name))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    hash.update('\0');
  }
  hash.update(process.version + '\0' + process.platform + '\0' + process.arch);
  return hash.digest('hex');
}

// Runs argv directly without a shell, with inherited stdio, and returns the
// exit code. `null` means the process was killed by a signal (or by the
// timeout); `timedOut` and `notFound` describe why.
function run(argv, { timeoutMs = 0 } = {}) {
  return new Promise(resolve => {
    const options = {
      cwd: process.cwd(),
      shell: false,
      stdio: 'inherit',
    };
    if (timeoutMs > 0) options.timeout = timeoutMs;

    const child = spawn(argv[0], argv.slice(1), options);
    let timedOut = false;
    let timer = null;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    child.on('error', error => {
      clearTimer();
      if (error.code === 'ETIMEDOUT') timedOut = true;
      resolve({ code: null, timedOut, notFound: !timedOut, error });
    });

    child.on('exit', (code, signal) => {
      clearTimer();
      if (timedOut) {
        resolve({ code: null, timedOut: true });
        return;
      }
      if (signal) {
        resolve({ code: null, signal });
        return;
      }
      resolve({ code: code === null ? EXIT_KILLED : code });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  if (separator === -1) {
    usageError();
    return EXIT_USAGE;
  }

  const testArgv = args.slice(separator + 1);
  if (testArgv.length === 0) {
    process.stderr.write(
      'error: no test command after "--"; expected the test command argv, for example: ' +
        'node src/npm-check.js -- npm test\n'
    );
    return EXIT_USAGE;
  }

  const cwd = process.cwd();

  // Only a successful install for these exact manifests can be reused.
  const fingerprint = dependencyFingerprint(cwd);
  const stamp = path.join(cwd, 'node_modules', '.strata-coder-install');
  if (!fingerprint) {
    process.stderr.write(
        'error: no package-lock.json or npm-shrinkwrap.json found in ' + cwd + '. ' +
          'Run "npm install" in the project to create a lock file before delegating ' +
          'to the test command; this helper never installs dependencies without a lock file.\n'
      );
    return EXIT_USAGE;
  }
  let previous;
  try { previous = fs.readFileSync(stamp, 'utf8'); } catch { /* Not installed successfully. */ }
  if (previous !== fingerprint) {
    fs.rmSync(stamp, { force: true });
    process.stdout.write('[strata-coder] installing dependencies with npm ci --ignore-scripts\n');
    const install = await run([npmExecutable(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });

    if (install.timedOut) {
      process.stderr.write(
        'error: dependency installation timed out after ' + INSTALL_TIMEOUT_MS + ' ms ' +
          '(npm ci --ignore-scripts was killed).\n'
      );
      return EXIT_KILLED;
    }
    if (install.notFound) {
      process.stderr.write(
        'error: could not run npm ci: "' + npmExecutable() + '" could not be spawned' +
          (install.error ? ' (' + install.error.message + ')' : '') + '.\n'
      );
      return EXIT_NOT_FOUND;
    }
    if (install.signal) {
      process.stderr.write(
        'error: dependency installation was killed by signal ' + install.signal + '.\n'
      );
      return EXIT_KILLED;
    }
    if (install.code !== 0) return install.code;
    if (dependencyFingerprint(cwd) !== fingerprint) {
      process.stderr.write('error: dependency manifests changed during installation; retry the check.\n');
      return EXIT_KILLED;
    }
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, fingerprint);
  }

  const test = await run(testArgv);

  if (test.notFound) {
    process.stderr.write(
      'error: test command executable "' + testArgv[0] + '" could not be found' +
        (test.error ? ' (' + test.error.message + ')' : '') + '.\n'
    );
    return EXIT_NOT_FOUND;
  }
  if (test.signal) {
    process.stderr.write('error: test command was killed by signal ' + test.signal + '.\n');
    return EXIT_KILLED;
  }
  return test.code;
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    process.stderr.write('error: ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = EXIT_KILLED;
  });

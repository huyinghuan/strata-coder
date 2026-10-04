import { spawn } from 'node:child_process';

// Checks get no API credentials or inherited runtime injection options.
export function executionEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}

export function runCommand(argv, { cwd, signal, timeoutMs = 60000, maxBytes = 24000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Aborted'));
    const child = spawn(argv[0], argv.slice(1), { cwd, env: executionEnv(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', total = 0, timedOut = false, aborted = false;
    const collect = chunk => {
      total += chunk.length;
      if (Buffer.byteLength(output) < maxBytes) output += chunk.toString('utf8').slice(0, maxBytes - Buffer.byteLength(output));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const kill = () => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const onAbort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, exitSignal) => {
      cleanup();
      if (aborted) return reject(signal.reason || new Error('Aborted'));
      resolve({ exit_code: code, signal: exitSignal, timed_out: timedOut, output, truncated: total > maxBytes });
    });
  });
}

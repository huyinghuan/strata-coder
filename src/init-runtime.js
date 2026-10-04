import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// npx owns its installation directory and may remove it at any time. Preserve
// the actual package bytes (including unpublished tarballs), not a registry
// version that might resolve to different code, in the ignored project state.
export async function prepareInitRuntime(packageRoot, projectRoot) {
  if (!packageRoot.split(/[\\/]/).includes('_npx')) return packageRoot;
  const runtimeDir = path.join(projectRoot, '.strata-coder', 'runtime');
  await fs.mkdir(runtimeDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(runtimeDir, '.install-'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = (args, cwd) => exec(npm, args, { cwd, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  try {
    const [pack] = JSON.parse((await run(['pack', '--json', '--ignore-scripts', '--pack-destination', staging], packageRoot)).stdout);
    const tarball = path.join(staging, pack.filename);
    const hash = crypto.createHash('sha256').update(await fs.readFile(tarball)).digest('hex');
    const destination = path.join(runtimeDir, hash);
    const installedRoot = path.join(destination, 'node_modules', 'strata-coder');
    try {
      await fs.access(path.join(destination, '.complete'));
      await fs.access(path.join(installedRoot, 'src', 'mcp.js'));
      return installedRoot;
    } catch { /* No complete runtime for this package yet. */ }

    const prefix = path.join(staging, 'install');
    await fs.mkdir(prefix);
    await fs.writeFile(path.join(prefix, 'package.json'), '{"private":true}');
    await run(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], prefix);
    await fs.writeFile(path.join(prefix, '.complete'), hash);
    try { await fs.rename(prefix, destination); }
    catch (error) {
      // Another init may have installed the same complete package concurrently.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await fs.access(path.join(destination, '.complete'));
    }
    return installedRoot;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { within } from './config.js';

// Error classes. Each sets name and code; some carry extra fields.
export class WorkspaceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceUnavailableError';
    this.code = 'workspace_unavailable';
  }
}

export class NoWorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoWorkspaceError';
    this.code = 'no_workspace';
  }
}

export class MultipleWorkspacesError extends Error {
  constructor(message, candidates) {
    super(message);
    this.name = 'MultipleWorkspacesError';
    this.code = 'multiple_workspaces';
    this.candidates = candidates;
  }
}

export class WorkspaceOutsideScopeError extends Error {
  constructor(message, roots) {
    super(message);
    this.name = 'WorkspaceOutsideScopeError';
    this.code = 'workspace_outside_scope';
    this.roots = roots;
  }
}

function isFilesystemRoot(p) {
  return path.parse(p).root === p;
}

// Normalize the protected directories so comparisons survive symlinked temp
// roots such as /var -> /private/var on macOS. Missing paths fall back to a
// plain resolve, which is still enough for prefix comparisons.
function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export class WorkspaceScope {
  constructor({ startupCwd, packageRoot, configDir, stateDir }) {
    // Capture the startup directory exactly once. Never read process.cwd() again.
    this.startupCwdRaw = startupCwd;
    this.startupCwdReal = null;
    this.startupCwdFailure = null;
    try {
      const real = fs.realpathSync(startupCwd);
      if (!fs.statSync(real).isDirectory()) {
        this.startupCwdFailure = 'startup directory is not a directory';
      } else {
        this.startupCwdReal = real;
      }
    } catch (error) {
      this.startupCwdFailure = `startup directory cannot be resolved: ${error.message}`;
    }

    this.packageRoot = realpathOrResolve(packageRoot);
    this.configDir = realpathOrResolve(configDir);
    this.stateDir = realpathOrResolve(stateDir);

    // Per-instance state only; no module-level mutable state.
    this.state = { status: 'unresolved', roots: [], source: null, reason: null, error: null, warnings: [] };

    this.started = false;
    this.supportsRoots = false;
    this.startPromise = null;
    this.refreshPromise = null;
    this.refreshGeneration = 0;

    this.getClientCapabilities = null;
    this.listRoots = null;
    this.onRootsChanged = null;
  }

  bind({ getClientCapabilities, listRoots, onRootsChanged }) {
    this.getClientCapabilities = getClientCapabilities;
    this.listRoots = listRoots;
    this.onRootsChanged = onRootsChanged;
    // Register the change handler once so roots/list_changed triggers a refresh.
    this.onRootsChanged(() => { this.refresh().catch(() => {}); });
    return this;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.started = true;
    this.startPromise = (async () => {
      const capabilities = this.getClientCapabilities?.();
      const supports = capabilities?.roots;
      if (!supports) {
        this.supportsRoots = false;
        this.#applyStartupCwd('client_unsupported_roots', []);
        return this.#snapshot();
      }
      this.supportsRoots = true;
      // Run the first roots resolution; failures are recorded in state, not thrown.
      await this.refresh();
      return this.#snapshot();
    })();
    return this.startPromise;
  }

  async refresh() {
    if (!this.started) await this.start();
    if (!this.supportsRoots) return this.#snapshot();

    const generation = ++this.refreshGeneration;
    // A notification invalidates the old scope immediately, until the latest
    // response resolves. Slow older responses must never restore revoked roots.
    this.state = { ...this.state, status: 'pending', roots: [], source: null };
    this.refreshPromise = this.#readRoots(generation);
    return this.refreshPromise;
  }

  async #readRoots(generation) {
    let result;
    try {
      result = await this.listRoots();
    } catch (error) {
      if (generation !== this.refreshGeneration) return this.#snapshot();
      // A failed roots request never falls back to the startup cwd.
      this.state = {
        status: 'error',
        error: `Failed to read MCP roots: ${error.message}`,
        roots: [],
        source: null,
        reason: null,
        warnings: this.state.warnings,
      };
      return this.#snapshot();
    }

    if (generation !== this.refreshGeneration) return this.#snapshot();
    const rawRoots = result?.roots;
    if (rawRoots !== undefined && !Array.isArray(rawRoots)) {
      // A malformed response must not silently widen the scope via the cwd.
      this.state = {
        status: 'error',
        error: 'Malformed roots response: "roots" must be an array',
        roots: [],
        source: null,
        reason: null,
        warnings: this.state.warnings,
      };
      return this.#snapshot();
    }

    const entries = Array.isArray(rawRoots) ? rawRoots : null;
    const warnings = [];
    const valid = [];

    for (const entry of entries ?? []) {
      const uri = entry?.uri;
      if (typeof uri !== 'string') {
        warnings.push(`${String(uri)} : uri is not a string`);
        continue;
      }
      let url;
      try {
        url = new URL(uri);
      } catch {
        warnings.push(`${uri} : uri is not a parseable URL`);
        continue;
      }
      if (url.protocol !== 'file:') {
        warnings.push(`${uri} : non-file protocol`);
        continue;
      }
      if (url.host !== '' && url.host !== 'localhost') {
        warnings.push(`${uri} : unexpected host`);
        continue;
      }
      let resolvedPath;
      try {
        resolvedPath = fileURLToPath(url);
      } catch {
        warnings.push(`${uri} : cannot convert file URI to a path`);
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(resolvedPath);
      } catch {
        warnings.push(`${uri} : path does not exist`);
        continue;
      }
      if (!stat.isDirectory()) {
        warnings.push(`${uri} : not a directory`);
        continue;
      }
      let real;
      try {
        real = fs.realpathSync(resolvedPath);
      } catch {
        warnings.push(`${uri} : cannot resolve realpath`);
        continue;
      }
      if (!valid.includes(real)) valid.push(real);
    }

    if (!entries || entries.length === 0) {
      // Empty or missing roots array falls back to the startup cwd.
      this.#applyStartupCwd('empty_roots', warnings);
      return this.#snapshot();
    }

    if (valid.length === 0) {
      // Non-empty roots but nothing usable: no cwd fallback.
      this.state = {
        status: 'error',
        error: `No usable local directory in MCP roots: ${warnings.join('; ')}`,
        roots: [],
        source: null,
        reason: null,
        warnings,
      };
      return this.#snapshot();
    }

    this.state = { status: 'ready', roots: valid, source: 'mcp_roots', reason: null, error: null, warnings };
    return this.#snapshot();
  }

  #startupCwdRejectReason(cwd) {
    if (isFilesystemRoot(cwd)) return 'startup directory is the filesystem root';
    const home = os.homedir();
    if (cwd === home) return 'startup directory is the home directory';
    if (within(cwd, home) && cwd !== home) return 'startup directory is an ancestor of the home directory';
    if (cwd === this.packageRoot) return 'startup directory is the package root';
    if (within(this.packageRoot, cwd)) return 'startup directory is inside the package root';
    if (cwd === this.stateDir) return 'startup directory is the state directory';
    if (within(this.stateDir, cwd)) return 'startup directory is inside the state directory';
    if (cwd === this.configDir) return 'startup directory is the config directory';
    return null;
  }

  #applyStartupCwd(reason, warnings) {
    const cwd = this.startupCwdReal;
    if (!cwd) {
      this.state = {
        status: 'error',
        error: `No usable host workspace directory: ${this.startupCwdFailure}`,
        roots: [],
        source: null,
        reason,
        warnings,
      };
      return;
    }
    const rejectReason = this.#startupCwdRejectReason(cwd);
    if (rejectReason) {
      this.state = {
        status: 'error',
        error: `No usable host workspace directory: ${rejectReason}`,
        roots: [],
        source: null,
        reason,
        warnings,
      };
      return;
    }
    this.state = { status: 'ready', roots: [cwd], source: 'cwd', reason, error: null, warnings };
  }

  #snapshot() {
    return {
      roots: [...this.state.roots],
      source: this.state.source,
      default: this.state.roots.length === 1 ? this.state.roots[0] : null,
      reason: this.state.reason ?? null,
      error: this.state.error ?? null,
      warnings: [...this.state.warnings],
    };
  }

  async #waitForRefresh() {
    let pending;
    do {
      pending = this.refreshPromise;
      await pending;
    } while (pending !== this.refreshPromise);
  }

  async describe() {
    try {
      await this.start();
      await this.#waitForRefresh();
      if (this.state.status !== 'ready') await this.refresh();
    } catch {
      // describe never throws; the recorded state error is reported instead.
    }
    return this.#snapshot();
  }

  allowsSync(absPath) {
    return this.state.status === 'ready' && this.state.roots.some(root => within(root, absPath));
  }

  async resolve() {
    await this.start();
    await this.#waitForRefresh();
    if (this.state.status !== 'ready') await this.refresh();
    if (this.state.status !== 'ready') {
      throw new WorkspaceUnavailableError(this.state.error);
    }
    return this.#snapshot();
  }

  async resolveTaskWorkspace(requested) {
    const snap = await this.resolve();
    const roots = snap.roots;

    if (requested == null) {
      if (roots.length === 0) throw new NoWorkspaceError('No workspace is available.');
      if (roots.length === 1) return roots[0];
      const candidates = [...roots].sort();
      throw new MultipleWorkspacesError(
        `Multiple workspaces are available (${candidates.join(', ')}); pass "workspace" to select one.`,
        candidates,
      );
    }

    if (typeof requested !== 'string' || requested.length === 0 || !path.isAbsolute(requested)) {
      throw new Error('workspace must be an absolute path.');
    }

    let real;
    try {
      real = fs.realpathSync(path.resolve(requested));
    } catch {
      throw new WorkspaceUnavailableError(`workspace must be an existing directory: ${requested}`);
    }
    let stat;
    try {
      stat = fs.statSync(real);
    } catch {
      throw new WorkspaceUnavailableError(`workspace must be an existing directory: ${requested}`);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceUnavailableError(`workspace must be an existing directory: ${requested}`);
    }

    if (!roots.some(root => within(root, real))) {
      throw new WorkspaceOutsideScopeError(
        `workspace is outside the current roots (${roots.join(', ')}).`,
        [...roots],
      );
    }

    return real;
  }
}

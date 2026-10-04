import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WorkspaceScope,
  WorkspaceUnavailableError,
  NoWorkspaceError,
  MultipleWorkspacesError,
  WorkspaceOutsideScopeError,
} from '../src/workspace-scope.js';

async function tempDir(t, name = 'ws-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `strata-coder-ws-${name}`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Fake adapters: no SDK, no network. `roots` is mutable so refresh() can observe changes.
function makeAdapter({ capabilities, roots }) {
  const state = { roots };
  const handler = { stored: null };
  return {
    state,
    getClientCapabilities: () => capabilities,
    listRoots: async () => {
      if (state.throw) throw new Error(state.throw);
      return { roots: state.roots };
    },
    onRootsChanged: cb => { handler.stored = cb; },
    handler,
  };
}

function buildScope(t, { capabilities, roots, startupName = 'startup' }) {
  return (async () => {
    const startupCwd = await tempDir(t, startupName);
    const packageRoot = await tempDir(t, 'pkg');
    const configDir = await tempDir(t, 'config');
    const stateDir = await tempDir(t, 'state');
    const adapter = makeAdapter({ capabilities, roots });
    const scope = new WorkspaceScope({ startupCwd, packageRoot, configDir, stateDir });
    scope.bind(adapter);
    return { scope, adapter, startupCwd, packageRoot, configDir, stateDir };
  })();
}

test('1. no roots capability falls back to startup cwd', async t => {
  const { scope, startupCwd } = await buildScope(t, { capabilities: {}, roots: [] });
  const snap = await scope.describe();
  assert.equal(snap.source, 'cwd');
  assert.equal(scope.state.reason, 'client_unsupported_roots');
  assert.equal(snap.default, await fs.realpath(startupCwd));
  const resolved = await scope.resolveTaskWorkspace();
  assert.equal(resolved, await fs.realpath(startupCwd));
});

test('2. single valid root uses mcp_roots', async t => {
  const rootDir = await tempDir(t, 'root');
  const adapter = makeAdapter({ capabilities: { roots: true }, roots: [{ uri: pathToFileURL(rootDir).toString() }] });
  const startupCwd = await tempDir(t, 'startup');
  const scope = new WorkspaceScope({
    startupCwd,
    packageRoot: await tempDir(t, 'pkg'),
    configDir: await tempDir(t, 'config'),
    stateDir: await tempDir(t, 'state'),
  });
  scope.bind(adapter);
  const snap = await scope.describe();
  assert.equal(snap.source, 'mcp_roots');
  assert.equal(snap.default, await fs.realpath(rootDir));
  const resolved = await scope.resolveTaskWorkspace();
  assert.equal(resolved, await fs.realpath(rootDir));
});

test('3. percent-encoded, Chinese, spaced and symlinked roots normalize to real directories', async t => {
  const base = await tempDir(t, 'unicode');
  const chinese = path.join(base, '项目 目录');
  const percent = path.join(base, '100%');
  const symlinkTarget = path.join(base, 'target');
  await fs.mkdir(chinese, { recursive: true });
  await fs.mkdir(percent, { recursive: true });
  await fs.mkdir(symlinkTarget, { recursive: true });
  const link = path.join(base, 'link');
  await fs.symlink(symlinkTarget, link, 'dir');

  const adapter = makeAdapter({
    capabilities: { roots: true },
    roots: [
      { uri: pathToFileURL(chinese).toString() },
      { uri: pathToFileURL(percent).toString() },
      { uri: pathToFileURL(link).toString() },
    ],
  });
  const scope = new WorkspaceScope({
    startupCwd: await tempDir(t, 'startup'),
    packageRoot: await tempDir(t, 'pkg'),
    configDir: await tempDir(t, 'config'),
    stateDir: await tempDir(t, 'state'),
  });
  scope.bind(adapter);
  const snap = await scope.describe();
  assert.equal(snap.source, 'mcp_roots');
  const realChinese = await fs.realpath(chinese);
  const realPercent = await fs.realpath(percent);
  const realTarget = await fs.realpath(symlinkTarget);
  assert.deepEqual(snap.roots, [realChinese, realPercent, realTarget]);
  assert.ok(snap.roots.includes(realTarget));
});

test('4. multiple roots require an explicit workspace; inside is accepted, outside rejected', async t => {
  const base = await tempDir(t, 'multi');
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  const outside = path.join(base, 'outside');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  const adapter = makeAdapter({
    capabilities: { roots: true },
    roots: [{ uri: pathToFileURL(rootB).toString() }, { uri: pathToFileURL(rootA).toString() }],
  });
  const scope = new WorkspaceScope({
    startupCwd: await tempDir(t, 'startup'),
    packageRoot: await tempDir(t, 'pkg'),
    configDir: await tempDir(t, 'config'),
    stateDir: await tempDir(t, 'state'),
  });
  scope.bind(adapter);

  const realA = await fs.realpath(rootA);
  const realB = await fs.realpath(rootB);
  await assert.rejects(() => scope.resolveTaskWorkspace(), err => {
    assert.ok(err instanceof MultipleWorkspacesError);
    assert.equal(err.code, 'multiple_workspaces');
    assert.deepEqual(err.candidates, [realA, realB]);
    assert.match(err.message, /workspace/);
    return true;
  });

  // Explicit workspace inside either root is accepted.
  const insideA = path.join(rootA, 'sub');
  await fs.mkdir(insideA, { recursive: true });
  assert.equal(await scope.resolveTaskWorkspace(insideA), await fs.realpath(insideA));
  assert.equal(await scope.resolveTaskWorkspace(rootB), await fs.realpath(rootB));

  // A sibling directory outside both roots is rejected.
  await assert.rejects(() => scope.resolveTaskWorkspace(outside), err => {
    assert.ok(err instanceof WorkspaceOutsideScopeError);
    assert.equal(err.code, 'workspace_outside_scope');
    assert.deepEqual(err.roots, [realB, realA]);
    return true;
  });
});

test('5. empty roots array falls back to startup cwd', async t => {
  const { scope, startupCwd } = await buildScope(t, { capabilities: { roots: true }, roots: [] });
  const snap = await scope.describe();
  assert.equal(snap.source, 'cwd');
  assert.equal(scope.state.reason, 'empty_roots');
  assert.equal(snap.default, await fs.realpath(startupCwd));
});

test('6. listRoots rejecting does not silently use the startup cwd', async t => {
  const adapter = makeAdapter({ capabilities: { roots: true }, roots: [] });
  adapter.state.throw = 'boom';
  const startupCwd = await tempDir(t, 'startup');
  const scope = new WorkspaceScope({
    startupCwd,
    packageRoot: await tempDir(t, 'pkg'),
    configDir: await tempDir(t, 'config'),
    stateDir: await tempDir(t, 'state'),
  });
  scope.bind(adapter);
  const snap = await scope.describe();
  assert.match(snap.error, /roots/);
  assert.equal(snap.source, null);
  await assert.rejects(() => scope.resolveTaskWorkspace(), err => {
    assert.ok(err instanceof WorkspaceUnavailableError);
    assert.equal(err.code, 'workspace_unavailable');
    return true;
  });
  // The startup cwd was never used as a fallback.
  assert.deepEqual(scope.state.roots, []);
});

test('7. mixed roots keep the valid directory and warn about rejected entries', async t => {
  const base = await tempDir(t, 'mixed');
  const validDir = path.join(base, 'valid');
  const fileEntry = path.join(base, 'file.txt');
  await fs.mkdir(validDir, { recursive: true });
  await fs.writeFile(fileEntry, 'x');
  const missing = path.join(base, 'missing');

  const adapter = makeAdapter({
    capabilities: { roots: true },
    roots: [
      { uri: 'https://example.com/x' },
      { uri: pathToFileURL(fileEntry).toString() },
      { uri: pathToFileURL(missing).toString() },
      { uri: pathToFileURL(validDir).toString() },
    ],
  });
  const scope = new WorkspaceScope({
    startupCwd: await tempDir(t, 'startup'),
    packageRoot: await tempDir(t, 'pkg'),
    configDir: await tempDir(t, 'config'),
    stateDir: await tempDir(t, 'state'),
  });
  scope.bind(adapter);
  const snap = await scope.describe();
  assert.equal(snap.source, 'mcp_roots');
  assert.deepEqual(snap.roots, [await fs.realpath(validDir)]);
  assert.equal(snap.warnings.length, 3);
  assert.ok(snap.warnings.some(w => w.includes('https://example.com/x')));
  assert.ok(snap.warnings.some(w => w.includes(fileEntry) || w.includes(pathToFileURL(fileEntry).toString())));
  assert.ok(snap.warnings.some(w => w.includes(missing) || w.includes(pathToFileURL(missing).toString())));
});

test('8. all roots invalid yields an error state without cwd fallback', async t => {
  const base = await tempDir(t, 'allbad');
  const fileEntry = path.join(base, 'file.txt');
  await fs.writeFile(fileEntry, 'x');
  const adapter = makeAdapter({
    capabilities: { roots: true },
    roots: [{ uri: 'https://example.com/x' }, { uri: pathToFileURL(fileEntry).toString() }],
  });
  const startupCwd = await tempDir(t, 'startup');
  const scope = new WorkspaceScope({
    startupCwd,
    packageRoot: await tempDir(t, 'pkg'),
    configDir: await tempDir(t, 'config'),
    stateDir: await tempDir(t, 'state'),
  });
  scope.bind(adapter);
  const snap = await scope.describe();
  assert.equal(snap.status ?? scope.state.status, 'error');
  assert.equal(scope.state.status, 'error');
  assert.equal(snap.source, null);
  assert.match(snap.error, /No usable local directory in MCP roots/);
  assert.notEqual(snap.default, await fs.realpath(startupCwd));
});

test('9. explicit workspace with .. segments inside a root is normalized; outside is rejected', async t => {
  const base = await tempDir(t, 'dots');
  const root = path.join(base, 'root');
  const sub = path.join(root, 'sub');
  await fs.mkdir(sub, { recursive: true });
  const adapter = makeAdapter({ capabilities: { roots: true }, roots: [{ uri: pathToFileURL(root).toString() }] });
  const scope = new WorkspaceScope({
    startupCwd: await tempDir(t, 'startup'),
    packageRoot: await tempDir(t, 'pkg'),
    configDir: await tempDir(t, 'config'),
    stateDir: await tempDir(t, 'state'),
  });
  scope.bind(adapter);

  const inside = path.join(sub, '..', 'sub');
  assert.equal(await scope.resolveTaskWorkspace(inside), await fs.realpath(sub));

  const outside = path.join(sub, '..', '..', 'outside');
  await fs.mkdir(outside, { recursive: true });
  await assert.rejects(() => scope.resolveTaskWorkspace(outside), err => {
    assert.ok(err instanceof WorkspaceOutsideScopeError);
    return true;
  });
});

test('10. startup-cwd fallback rejects protected directories', async t => {
  const packageRoot = await tempDir(t, 'pkg');
  const configDir = await tempDir(t, 'config');
  const stateDir = await tempDir(t, 'state');

  async function expectReject(startupCwd, rule) {
    const adapter = makeAdapter({ capabilities: {}, roots: [] });
    const scope = new WorkspaceScope({ startupCwd, packageRoot, configDir, stateDir });
    scope.bind(adapter);
    const snap = await scope.describe();
    assert.equal(scope.state.status, 'error');
    assert.match(snap.error, /^No usable host workspace directory: /);
    assert.match(snap.error, new RegExp(rule));
  }

  await fs.mkdir(path.join(packageRoot, 'inside'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'child'), { recursive: true });
  await expectReject(packageRoot, 'package root');
  await expectReject(path.join(packageRoot, 'inside'), 'package root');
  await expectReject(stateDir, 'state directory');
  await expectReject(path.join(stateDir, 'child'), 'state directory');
  await expectReject(configDir, 'config directory');
  await expectReject(os.homedir(), 'home directory');
  await expectReject(path.parse(os.homedir()).root, 'filesystem root');
});

test('11. refresh after changing roots updates describe and allowsSync; handler triggers adapter', async t => {
  const base = await tempDir(t, 'refresh');
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });

  const adapter = makeAdapter({ capabilities: { roots: true }, roots: [{ uri: pathToFileURL(rootA).toString() }] });
  const scope = new WorkspaceScope({
    startupCwd: await tempDir(t, 'startup'),
    packageRoot: await tempDir(t, 'pkg'),
    configDir: await tempDir(t, 'config'),
    stateDir: await tempDir(t, 'state'),
  });
  scope.bind(adapter);

  const realA = await fs.realpath(rootA);
  const realB = await fs.realpath(rootB);
  await scope.describe();
  assert.ok(scope.allowsSync(path.join(realA, 'file')));
  assert.ok(!scope.allowsSync(path.join(realB, 'file')));

  // Change the fake roots, then trigger the registered handler. The handler is
  // fire-and-forget, so flush pending microtasks before reading the snapshot.
  adapter.state.roots = [{ uri: pathToFileURL(rootB).toString() }];
  await adapter.handler.stored();
  await new Promise(resolve => setTimeout(resolve, 0));
  const snap = await scope.describe();
  assert.deepEqual(snap.roots, [realB]);
  assert.ok(scope.allowsSync(path.join(realB, 'file')));
  assert.ok(!scope.allowsSync(path.join(realA, 'file')));
});

test('12. two instances are independent', async t => {
  const base = await tempDir(t, 'independent');
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });

  const adapterA = makeAdapter({ capabilities: { roots: true }, roots: [{ uri: pathToFileURL(rootA).toString() }] });
  const adapterB = makeAdapter({ capabilities: { roots: true }, roots: [{ uri: pathToFileURL(rootB).toString() }] });

  const scopeA = new WorkspaceScope({
    startupCwd: await tempDir(t, 'startupA'),
    packageRoot: await tempDir(t, 'pkgA'),
    configDir: await tempDir(t, 'configA'),
    stateDir: await tempDir(t, 'stateA'),
  });
  const scopeB = new WorkspaceScope({
    startupCwd: await tempDir(t, 'startupB'),
    packageRoot: await tempDir(t, 'pkgB'),
    configDir: await tempDir(t, 'configB'),
    stateDir: await tempDir(t, 'stateB'),
  });
  scopeA.bind(adapterA);
  scopeB.bind(adapterB);

  const snapA = await scopeA.describe();
  const snapB = await scopeB.describe();
  const realA = await fs.realpath(rootA);
  const realB = await fs.realpath(rootB);
  assert.deepEqual(snapA.roots, [realA]);
  assert.deepEqual(snapB.roots, [realB]);
  assert.ok(scopeA.allowsSync(path.join(realA, 'x')));
  assert.ok(!scopeA.allowsSync(path.join(realB, 'x')));
  assert.ok(scopeB.allowsSync(path.join(realB, 'x')));
  assert.ok(!scopeB.allowsSync(path.join(realA, 'x')));
});

for (const staleFailure of [false, true]) test(`latest roots win over stale ${staleFailure ? 'error' : 'success'} responses`, async t => {
  const a = await fs.realpath(await tempDir(t, 'old'));
  const b = await fs.realpath(await tempDir(t, 'new'));
  const { scope } = await buildScope(t, { capabilities: { roots: {} }, roots: [{ uri: pathToFileURL(a).href }] });
  await scope.start();
  let finishOld, failOld;
  scope.listRoots = () => new Promise((resolve, reject) => { finishOld = resolve; failOld = reject; });
  const old = scope.refresh();
  assert.equal(scope.allowsSync(a), false, 'old permissions are revoked while refreshing');
  scope.listRoots = async () => ({ roots: [{ uri: pathToFileURL(b).href }] });
  await scope.refresh();
  if (staleFailure) failOld(new Error('late failure')); else finishOld({ roots: [{ uri: pathToFileURL(a).href }] });
  await old;
  assert.equal((await scope.describe()).default, b);
  assert.equal(scope.allowsSync(a), false);
  assert.equal(await scope.resolveTaskWorkspace(), b);
  await assert.rejects(scope.resolveTaskWorkspace(a), WorkspaceOutsideScopeError);
});

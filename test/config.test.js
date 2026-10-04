import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, defaultConfigPath, projectConfigPath } from '../src/config.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strata-coder-config-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function configFile(t, values) {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(values));
  return { dir, configPath };
}

test('loadConfig applies baseUrl, model and apiKeyEnv overrides before validation', async t => {
  const { configPath } = await configFile(t, {
    baseUrl: 'http://127.0.0.1:1/v1', model: 'file-model', apiKeyEnv: 'FILE_API_KEY',
    stateDir: 'state', endpointLockDir: 'locks',
  });
  const overrides = { baseUrl: 'http://127.0.0.2:2/v1', model: 'override-model', apiKeyEnv: 'OVERRIDE_API_KEY' };
  const config = loadConfig(configPath, overrides);
  assert.equal(config.baseUrl, 'http://127.0.0.2:2/v1');
  assert.equal(config.model, 'override-model');
  assert.equal(config.apiKeyEnv, 'OVERRIDE_API_KEY');
  assert.deepEqual(overrides, { baseUrl: 'http://127.0.0.2:2/v1', model: 'override-model', apiKeyEnv: 'OVERRIDE_API_KEY' });
  assert.equal(config.configPath, await fs.realpath(configPath));
});

test('overrides are applied in memory and never rewrite the config file', async t => {
  const { configPath } = await configFile(t, {
    baseUrl: 'http://127.0.0.1:1/v1', model: 'file-model', apiKeyEnv: 'FILE_API_KEY',
  });
  const before = await fs.readFile(configPath, 'utf8');
  const config = loadConfig(configPath, { baseUrl: 'http://127.0.0.1:2/v1', model: 'cli-model', apiKeyEnv: '' });
  assert.equal(config.baseUrl, 'http://127.0.0.1:2/v1');
  assert.equal(config.model, 'cli-model');
  assert.equal(config.apiKeyEnv, '');
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
  const onDisk = JSON.parse(before);
  assert.equal(onDisk.baseUrl, 'http://127.0.0.1:1/v1');
  assert.equal(onDisk.model, 'file-model');
  assert.equal(onDisk.apiKeyEnv, 'FILE_API_KEY');
});

test('unspecified override keys keep the file values and undefined values do not override', async t => {
  const { configPath } = await configFile(t, {
    baseUrl: 'http://127.0.0.1:1/v1', model: 'file-model', apiKeyEnv: 'FILE_API_KEY',
  });
  const config = loadConfig(configPath, { model: 'override-model' });
  assert.equal(config.baseUrl, 'http://127.0.0.1:1/v1');
  assert.equal(config.model, 'override-model');
  assert.equal(config.apiKeyEnv, 'FILE_API_KEY');
  const same = loadConfig(configPath, { baseUrl: undefined, model: undefined, apiKeyEnv: undefined });
  assert.equal(same.baseUrl, 'http://127.0.0.1:1/v1');
  assert.equal(same.model, 'file-model');
  assert.equal(same.apiKeyEnv, 'FILE_API_KEY');
});

test('an explicit empty-string apiKeyEnv override is applied, not ignored', async t => {
  const { configPath } = await configFile(t, {
    baseUrl: 'http://127.0.0.1:1/v1', model: 'file-model', apiKeyEnv: 'FILE_API_KEY',
  });
  const config = loadConfig(configPath, { apiKeyEnv: '' });
  assert.equal(config.apiKeyEnv, '');
});

test('loadConfig without overrides keeps existing validation and path resolution', async t => {
  const { configPath } = await configFile(t, {
    baseUrl: 'http://127.0.0.1:1/v1/', model: 'file-model', stateDir: 'state', endpointLockDir: 'locks',
  });
  const config = loadConfig(configPath);
  assert.equal(config.baseUrl, 'http://127.0.0.1:1/v1');
  assert.equal(config.model, 'file-model');
  assert.equal(config.apiKeyEnv, 'LOCAL_CODER_API_KEY');
  assert.equal(config.stateDir, await fs.realpath(path.join(path.dirname(configPath), 'state')));
  assert.equal(config.endpointLockDir, await fs.realpath(path.join(path.dirname(configPath), 'locks')));
  assert.equal(config.configPath, await fs.realpath(configPath));
  assert.ok(await fs.stat(config.stateDir));

  const bad = await configFile(t, { baseUrl: 'http://example.invalid/v1?token=1', model: 'file-model' });
  assert.throws(() => loadConfig(bad.configPath), /baseUrl must be an http\(s\) endpoint/);
  assert.throws(() => loadConfig(bad.configPath, { baseUrl: 'not-a-url' }), /Invalid url/);
  assert.throws(() => loadConfig(null), /Pass --config/);
});

test('defaultConfigPath prefers strata-coder.config.json, then local-coder.config.json, and never the example', async t => {
  const dir = await tempDir(t);
  const example = path.join(dir, 'strata-coder.config.example.json');
  const local = path.join(dir, 'local-coder.config.json');
  const strata = path.join(dir, 'strata-coder.config.json');
  await fs.writeFile(example, '{}');

  // The example file is a template, not a runnable config, so it is not returned.
  assert.equal(defaultConfigPath(dir), null);

  await fs.writeFile(local, '{}');
  assert.equal(defaultConfigPath(dir), local);

  await fs.writeFile(strata, '{}');
  assert.equal(defaultConfigPath(dir), strata);

  // A directory is not a regular file, so resolution falls through to the next candidate.
  await fs.rm(strata);
  assert.equal(defaultConfigPath(dir), local);
  await fs.mkdir(strata);
  assert.equal(defaultConfigPath(dir), local);

  const empty = await tempDir(t);
  assert.equal(defaultConfigPath(empty), null);
});

test('projectConfigPath resolves the project-local config under .strata-coder', async t => {
  const dir = await tempDir(t);
  assert.equal(projectConfigPath(dir), path.join(dir, '.strata-coder', 'config.json'));
});

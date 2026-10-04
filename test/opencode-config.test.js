import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { fileURLToPath } from 'node:url';
import {
  parseOpenCodeVersion,
  looksLikeStrataCoderServer,
  upsertStrataCoderConfig,
  readProjectConfig,
} from '../src/opencode-config.js';

const COMMAND = ['npx', '-y', 'strata-coder@0.1.0', '--config', 'strata-coder.config.json'];

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-config-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseOpenCodeVersion recognizes 2.x, 1.x and rejects unrelated text', () => {
  assert.equal(parseOpenCodeVersion('opencode v2.0.22'), 2);
  assert.equal(parseOpenCodeVersion('2.1.0'), 2);
  assert.equal(parseOpenCodeVersion('opencode 2.1.0'), 2);
  assert.equal(parseOpenCodeVersion('opencode v1.9.5'), 1);
  assert.equal(parseOpenCodeVersion('no version here'), null);
  assert.equal(parseOpenCodeVersion('build 12345 revision 67890'), null);
  assert.equal(parseOpenCodeVersion(''), null);
});

test('looksLikeStrataCoderServer recognizes the actual executable or package', () => {
  assert.equal(looksLikeStrataCoderServer({ command: ['npx', '-y', 'strata-coder@0.1.0', '--config', 'x'] }), true);
  assert.equal(looksLikeStrataCoderServer({ command: [process.execPath, fileURLToPath(new URL('../src/mcp.js', import.meta.url))] }), true);
  assert.equal(looksLikeStrataCoderServer({ command: ['node', 'other-server.js'] }), false);
  assert.equal(looksLikeStrataCoderServer({ command: ['strata-coder'] }), true);
  assert.equal(looksLikeStrataCoderServer({ command: 'strata-coder' }), false);
  assert.equal(looksLikeStrataCoderServer({}), false);
  assert.equal(looksLikeStrataCoderServer(null), false);
});

test('empty text creates a config with $schema and the complete server object', () => {
  const result = upsertStrataCoderConfig('', { command: COMMAND });
  assert.equal(result.conflict, false);
  assert.equal(result.changed, true);
  assert.ok(result.text.includes('https://opencode.ai/config.json'));
  assert.ok(result.text.endsWith('\n'));

  const parsed = parse(result.text);
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assert.deepEqual(parsed.mcp.servers.strata_coder.command, COMMAND);
  assert.equal(parsed.mcp.servers.strata_coder.type, 'local');
  assert.equal(parsed.mcp.servers.strata_coder.codemode, false);

  // whitespace-only input behaves the same way
  const blank = upsertStrataCoderConfig('   \n\t ', { command: COMMAND });
  assert.ok(blank.text.includes('https://opencode.ai/config.json'));
  assert.deepEqual(parse(blank.text).mcp.servers.strata_coder.command, COMMAND);
});

test('upsert preserves comments, model, providers, other MCP servers and top-level keys', () => {
  const text = [
    '{',
    '  // OpenCode project config',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "model": "anthropic/claude-3.7", /* primary model */',
    '  "provider": {',
    '    "local": { "options": { "baseURL": "http://127.0.0.1:11434/v1" } }',
    '  },',
    '  "mcp": {',
    '    "servers": {',
    '      // unrelated server must survive',
    '      "other": { "type": "remote", "url": "https://example.com/mcp" }',
    '    }',
    '  },',
    '  "theme": "dark" // trailing comment',
    '}',
  ].join('\n');

  const result = upsertStrataCoderConfig(text, { command: COMMAND });
  assert.equal(result.conflict, false);
  assert.equal(result.changed, true);

  for (const comment of ['OpenCode project config', 'primary model', 'unrelated server must survive', 'trailing comment']) {
    assert.ok(result.text.includes(comment), `comment lost: ${comment}`);
  }

  const parsed = parse(result.text);
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assert.equal(parsed.model, 'anthropic/claude-3.7');
  assert.deepEqual(parsed.provider, { local: { options: { baseURL: 'http://127.0.0.1:11434/v1' } } });
  assert.equal(parsed.theme, 'dark');
  assert.deepEqual(parsed.mcp.servers.other, { type: 'remote', url: 'https://example.com/mcp' });
  assert.deepEqual(parsed.mcp.servers.strata_coder, { type: 'local', command: COMMAND, codemode: false });
});

test('an existing strata_coder in npx form is replaced with the complete object', () => {
  const text = [
    '{',
    '  "mcp": {',
    '    "servers": {',
    '      "strata_coder": {',
    '        "type": "local",',
    '        "command": ["npx", "-y", "strata-coder@0.0.9"]',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const result = upsertStrataCoderConfig(text, { command: COMMAND });
  assert.equal(result.conflict, false);
  assert.equal(result.changed, true);

  const parsed = parse(result.text);
  assert.deepEqual(parsed.mcp.servers.strata_coder, { type: 'local', command: COMMAND, codemode: false });
  assert.ok(result.text.includes('"codemode": false'));
});

test('upsert is idempotent when the desired object is already present', () => {
  const text = [
    '{',
    '  "mcp": {',
    '    "servers": {',
    '      "strata_coder": {',
    '        "type": "local",',
    '        "command": ["npx", "-y", "strata-coder@0.1.0", "--config", "strata-coder.config.json"],',
    '        "codemode": false',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const result = upsertStrataCoderConfig(text, { command: COMMAND });
  assert.equal(result.conflict, false);
  assert.equal(result.changed, false);
  assert.equal(result.text, text);

  // running it again on the produced text stays idempotent
  const again = upsertStrataCoderConfig(result.text, { command: COMMAND });
  assert.equal(again.changed, false);
  assert.equal(again.text, result.text);
});

test('a same-name server pointing to another program reports a conflict and is not overwritten', () => {
  const text = [
    '{',
    '  "mcp": {',
    '    "servers": {',
    '      "strata_coder": { "type": "local", "command": ["node", "other-server.js"] }',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const result = upsertStrataCoderConfig(text, { command: COMMAND });
  assert.equal(result.conflict, true);
  assert.equal(result.text, text);
  assert.deepEqual(result.server, { type: 'local', command: ['node', 'other-server.js'] });

  const parsed = parse(result.text);
  assert.deepEqual(parsed.mcp.servers.strata_coder, { type: 'local', command: ['node', 'other-server.js'] });
});

test('command entries with spaces and Chinese characters survive a round-trip', () => {
  const command = [process.execPath, fileURLToPath(new URL('../src/mcp.js', import.meta.url)), '--config', '我的 配置.json', '你好 世界'];
  const result = upsertStrataCoderConfig('', { command, eol: '\r\n' });
  const parsed = parse(result.text);
  assert.deepEqual(parsed.mcp.servers.strata_coder.command, command);
  assert.ok(result.text.includes('\r\n'));

  // round-trip again over the produced text
  const second = upsertStrataCoderConfig(result.text, { command, eol: '\r\n' });
  assert.equal(second.changed, false);
  assert.deepEqual(parse(second.text).mcp.servers.strata_coder.command, command);
});

test('readProjectConfig follows the documented candidate priority', async t => {
  const dir = await tempDir(t);
  await fs.mkdir(path.join(dir, '.opencode'), { recursive: true });
  const jsonc = path.join(dir, '.opencode', 'opencode.jsonc');
  const json = path.join(dir, '.opencode', 'opencode.json');
  await fs.writeFile(jsonc, '{}');
  await fs.writeFile(json, '{}');
  await fs.writeFile(path.join(dir, 'opencode.jsonc'), '{}');
  await fs.writeFile(path.join(dir, 'opencode.json'), '{}');

  assert.deepEqual(readProjectConfig(dir), { path: jsonc, exists: true });

  await fs.rm(jsonc);
  assert.deepEqual(readProjectConfig(dir), { path: json, exists: true });

  await fs.rm(json);
  assert.deepEqual(readProjectConfig(dir), { path: path.join(dir, 'opencode.jsonc'), exists: true });

  await fs.rm(path.join(dir, 'opencode.jsonc'));
  assert.deepEqual(readProjectConfig(dir), { path: path.join(dir, 'opencode.json'), exists: true });

  // a directory named like a candidate is not treated as a file
  await fs.rm(path.join(dir, 'opencode.json'));
  await fs.mkdir(path.join(dir, 'opencode.json'));
  assert.deepEqual(readProjectConfig(dir), { path: path.join(dir, '.opencode', 'opencode.json'), exists: false });
});

for (const command of [
  ['node', '/opt/other-agent/src/mcp.js'],
  ['node', 'other.js', '--config', '/tmp/strata-coder/config.json'],
  ['npx', '-y', 'other-server', '--name', 'strata-coder'],
  ['npx', '-y', 'strata-coder-impostor'],
]) test(`do not overwrite foreign command ${JSON.stringify(command)}`, () => {
  const text = JSON.stringify({ mcp: { servers: { strata_coder: { type: 'local', command } } } });
  const result = upsertStrataCoderConfig(text, { command: COMMAND });
  assert.equal(result.conflict, true);
  assert.equal(result.text, text);
});

test('updating our command preserves disabled, environment and timeout settings', () => {
  const settings = { type: 'local', command: ['strata-coder'], disabled: true, environment: { KEY: '{env:KEY}' }, timeout: { startup: 60000 } };
  const result = upsertStrataCoderConfig(JSON.stringify({ mcp: { servers: { strata_coder: settings } } }), { command: COMMAND });
  assert.deepEqual(parse(result.text).mcp.servers.strata_coder, { ...settings, command: COMMAND, codemode: false });
});

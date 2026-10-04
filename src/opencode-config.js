import fs from 'node:fs';
import path from 'node:path';
import { parse, modify, applyEdits } from 'jsonc-parser';

const SERVER_KEY = 'strata_coder';
const SCHEMA_URL = 'https://opencode.ai/config.json';
const VERSION_PATTERN = /\d+\.\d+\.\d+/;

/**
 * Extract the major version from an OpenCode version string such as
 * `opencode v2.0.22`, `2.0.22` or `opencode 2.1.0`.
 * Returns null when no `x.y.z` version is present.
 */
export function parseOpenCodeVersion(output) {
  if (typeof output !== 'string') return null;
  const match = VERSION_PATTERN.exec(output);
  if (!match) return null;
  return Number(match[0].split('.')[0]);
}

// Recognize executable/package identity, never arbitrary argument substrings.
export function looksLikeStrataCoderServer(server) {
  if (!server || server.type === 'remote' || !Array.isArray(server.command)) return false;
  const [executable, ...args] = server.command;
  if (typeof executable !== 'string') return false;
  const bin = path.basename(executable).replace(/\.(cmd|exe)$/i, '');
  if (bin === 'strata-coder') return true;
  if (bin === 'npx') {
    let i = 0;
    while (['-y', '--yes', '--no-install', '--'].includes(args[i])) i++;
    return typeof args[i] === 'string' && /^strata-coder(?:@[^/\\\s]+)?$/.test(args[i]);
  }
  const entry = bin === 'node' ? args[0] : executable;
  if (typeof entry !== 'string' || !path.isAbsolute(entry)) return false;
  try {
    const real = fs.realpathSync(entry);
    const root = path.dirname(path.dirname(real));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg.name === 'strata-coder' && pkg.bin?.['strata-coder'] === 'src/mcp.js'
      && real === path.join(root, 'src', 'mcp.js');
  } catch { return false; }
}

function isBlank(text) {
  return text === undefined || text === null || String(text).trim() === '';
}

/**
 * Insert or replace `mcp.servers.strata_coder` in an OpenCode 2.x config while
 * preserving comments, formatting, the primary model, providers and other MCP
 * servers.
 */
export function upsertStrataCoderConfig(text, options = {}) {
  const command = Array.isArray(options.command) ? options.command : [];
  const eol = options.eol === '\r\n' ? '\r\n' : '\n';
  let desired = { type: 'local', command, codemode: false };

  if (isBlank(text)) {
    text = `${JSON.stringify({ $schema: SCHEMA_URL }, null, 2)}${eol}`;
  }

  const errors = [];
  const existing = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('Invalid OpenCode JSONC; refusing to overwrite it.');
  }
  const existingServer = existing && existing.mcp ? existing.mcp.servers?.[SERVER_KEY] : undefined;

  if (existingServer !== undefined && !looksLikeStrataCoderServer(existingServer)) {
    return { conflict: true, server: existingServer, text };
  }

  desired = { ...existingServer, ...desired };

  if (existingServer !== undefined && JSON.stringify(existingServer) === JSON.stringify(desired)) {
    return { conflict: false, changed: false, text };
  }

  const edits = modify(text, ['mcp', 'servers', SERVER_KEY], desired, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  const newText = applyEdits(text, edits);

  return { conflict: false, changed: true, text: newText };
}

/**
 * Return `{ path, exists }` for the first existing OpenCode config file, using
 * the documented candidate priority.
 */
export function readProjectConfig(rootDir) {
  const candidates = [
    path.join(rootDir, '.opencode', 'opencode.jsonc'),
    path.join(rootDir, '.opencode', 'opencode.json'),
    path.join(rootDir, 'opencode.jsonc'),
    path.join(rootDir, 'opencode.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { path: candidate, exists: true };
    }
  }

  return { path: path.join(rootDir, '.opencode', 'opencode.json'), exists: false };
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

const command = z.object({
  command: z.array(z.string().min(1)).min(1),
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
}).strict();

const configSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKeyEnv: z.string().default('LOCAL_CODER_API_KEY'),
  workspaceRoots: z.array(z.string().min(1)).min(1),
  stateDir: z.string().default('.local-coder-state'),
  checks: z.record(command).default({}),
  defaultChecks: z.array(z.string()).default([]),
  requireChecks: z.boolean().default(true),
  maxRepairAttempts: z.number().int().min(0).max(10).default(2),
  endpointLockDir: z.string().default(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `local-coder-endpoints-${process.getuid?.() ?? 'user'}`)),
  maxTurns: z.number().int().min(1).max(100).default(20),
  maxTaskSeconds: z.number().int().min(5).max(7200).default(900),
  requestTimeoutSeconds: z.number().int().min(1).max(600).default(360),
  maxOutputTokens: z.number().int().min(128).max(32768).default(13000),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).nullable().default('low'),
  maxContextChars: z.number().int().min(4000).max(1000000).default(120000),
  maxFileBytes: z.number().int().min(1024).max(10000000).default(256000),
  maxSnapshotBytes: z.number().int().min(1024).max(1000000000).default(50000000),
  maxSnapshotFiles: z.number().int().min(1).max(100000).default(5000),
  exclude: z.array(z.string()).default([]),
  temperature: z.number().min(0).max(2).default(0),
}).strict();

export function loadConfig(filename) {
  if (!filename) throw new Error('Pass --config /absolute/path/strata-coder.config.json or STRATA_CODER_CONFIG (legacy LOCAL_CODER_CONFIG also supported).');
  const configPath = fs.realpathSync(filename);
  const dir = path.dirname(configPath);
  const config = configSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const url = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl must be an http(s) endpoint without credentials, query or fragment.');
  }
  config.baseUrl = url.toString().replace(/\/+$/, '');
  config.workspaceRoots = config.workspaceRoots.map(p => fs.realpathSync(path.resolve(dir, p)));
  config.stateDir = path.resolve(dir, config.stateDir);
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  config.stateDir = fs.realpathSync(config.stateDir);
  config.endpointLockDir = path.resolve(dir, config.endpointLockDir);
  fs.mkdirSync(config.endpointLockDir, { recursive: true, mode: 0o700 });
  config.endpointLockDir = fs.realpathSync(config.endpointLockDir);
  config.configPath = configPath;
  for (const name of config.defaultChecks) {
    if (!Object.hasOwn(config.checks, name)) throw new Error(`Unknown default check: ${name}`);
  }
  return config;
}

export const taskSchema = z.object({
  workspace: z.string().min(1).describe('Absolute project directory on the machine running this worker.'),
  task: z.string().min(1).max(24000).describe('Concrete implementation goal, context and constraints.'),
  acceptance: z.array(z.string().min(1).max(4000)).min(1).max(30).describe('Observable acceptance criteria.'),
  allowed_paths: z.array(z.string().min(1)).max(100).default([]).describe('Relative file/directory prefixes; empty allows all non-excluded project files. No globs.'),
  check_names: z.array(z.string().min(1)).max(20).optional().describe('Configured checks to run in addition to mandatory defaultChecks.'),
  request_id: z.string().min(1).max(128).regex(/^[\w.-]+$/).describe('Stable unique ID for this submission; reuse only when retrying identical arguments.'),
}).strict();

export function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function cleanRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) {
    throw new Error('Expected a non-empty relative POSIX path.');
  }
  const parts = value.split('/');
  if (parts.some(p => p === '..' || p === '.git' || p === '.local-coder-state')) throw new Error('Forbidden path.');
  const normalized = path.posix.normalize(value).replace(/\/$/, '');
  if (normalized === '.') throw new Error('Specify a file or subdirectory, not the project root.');
  return normalized;
}

export function allowedFile(relative, prefixes) {
  return !prefixes.length || prefixes.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
}

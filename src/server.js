import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { taskSchema } from './config.js';
import { submitTask, getTask, cancelTask, readArtifact } from './jobs.js';
import { WorkspaceScope } from './workspace-scope.js';
import { metadata } from './metadata.js';

export async function serve(config) {
  // The workspace scope belongs to THIS connection only. It is resolved from
  // the client's MCP roots when the capability is advertised, and otherwise
  // falls back to the directory the host started this process in. Nothing is
  // shared through module-level state.
  const scope = new WorkspaceScope({
    startupCwd: process.cwd(),
    packageRoot: fileURLToPath(new URL('../', import.meta.url)),
    configDir: path.dirname(config.configPath),
    stateDir: config.stateDir,
  });

  const server = new McpServer(metadata, {
    instructions: 'Local implementation is optional. Honor the user\'s per-task choice: when asked to implement directly or avoid local models, do not submit tasks. If taking over a running local task, cancel that task and confirm its terminal state before reviewing any partial patch. Do not cancel unrelated tasks. When delegation is selected, use submit_task. The host provides the workspace scope: omit workspace unless get_capabilities reports multiple roots or a subdirectory is wanted. The local worker edits a COPY and returns a patch; it never applies changes to the original project. Preserve task IDs; use get_task(wait_seconds=20) rather than submitting duplicates. ready_for_review means review the patch and actual check results, not that acceptance is proven. Use read_artifact only as needed to keep context small.',
  });

  // Roots are requested only after initialization and only when the client
  // advertised the capability. A roots/list_changed notification refreshes the
  // scope for future submissions; already submitted tasks keep their directory.
  scope.bind({
    getClientCapabilities: () => server.server.getClientCapabilities(),
    listRoots: () => server.server.listRoots(),
    onRootsChanged: handler => server.server.setNotificationHandler(RootsListChangedNotificationSchema, handler),
  });
  server.server.oninitialized = () => { scope.start().catch(() => {}); };

  const wrap = fn => async args => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const payload = { error: error.message };
      if (typeof error.code === 'string') payload.code = error.code;
      if (Array.isArray(error.candidates)) payload.candidates = error.candidates;
      if (Array.isArray(error.roots)) payload.roots = error.roots;
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
  };
  server.registerTool('submit_task', {
    description: 'Delegate one bounded function/module implementation or bug fix when local implementation is selected. Split cross-module work first. Do not use when the user requests primary-model-only execution. Provide a concrete goal, acceptance criteria, scoped allowed_paths and configured check names. The workspace parameter is optional: omit it to use the single host workspace reported by get_capabilities, or pass a directory inside the host roots to select a subproject. An explicit workspace can never expand the host-provided roots. By default at least one check is required. Returns a task ID immediately. Edits a COPY, never the original. request_id is stable across retries. needs_primary is terminal: review its partial patch and failure summary, then take over instead of blindly resubmitting.',
    inputSchema: taskSchema.shape,
  }, wrap(args => submitTask(config, args, scope)));
  server.registerTool('get_task', {
    description: 'Get compact progress or final results of a previously submitted task from this connection\'s workspace roots. Prefer wait_seconds=20 to reduce polling. Does not return full code or logs. ready_for_review still requires primary-model review and patch application.',
    inputSchema: { task_id: z.string(), wait_seconds: z.number().int().min(0).max(25).default(20) },
    annotations: { readOnlyHint: true },
  }, wrap(args => getTask(config, args.task_id, args.wait_seconds, scope)));
  server.registerTool('cancel_task', {
    description: 'Request cancellation of a task from this connection\'s workspace roots. The worker aborts pending inference and configured checks. Query get_task to confirm final status.',
    inputSchema: { task_id: z.string() },
  }, wrap(args => cancelTask(config, args.task_id, scope)));
  server.registerTool('read_artifact', {
    description: 'Read a paginated task artifact (patch, checks, or events) for a task from this connection\'s workspace roots. Offsets and limits count JavaScript string characters. Retrieve the patch for review; check logs only when needed.',
    inputSchema: { task_id: z.string(), artifact: z.enum(['patch', 'checks', 'events']), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(24000).default(12000) },
    annotations: { readOnlyHint: true },
  }, wrap(args => readArtifact(config, args.task_id, args.artifact, args.offset, args.limit, scope)));
  server.registerTool('get_capabilities', {
    description: 'List the configured model, the resolved host workspace roots and their source, available check names and budgets before delegating. workspace.default is the directory used when submit_task omits workspace; it is null when multiple roots require an explicit choice. Does not invoke the model.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, wrap(async () => ({ model: config.model, workspace: await scope.describe(), checks: Object.keys(config.checks),
    default_checks: config.defaultChecks, max_turns: config.maxTurns, max_task_seconds: config.maxTaskSeconds,
    require_checks: config.requireChecks, checks_configured: Object.keys(config.checks).length > 0,
    max_repair_attempts: config.maxRepairAttempts, endpoint_concurrency: 1, temperature: config.temperature,
    reasoning_effort: config.reasoningEffort, max_output_tokens: config.maxOutputTokens,
    max_context_chars: config.maxContextChars, request_timeout_seconds: config.requestTimeoutSeconds,
    writes_original: false, isolation: 'working copy; configured commands run with host user permissions, not an OS sandbox' })));
  await server.connect(new StdioServerTransport());
}

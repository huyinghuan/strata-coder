import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { taskSchema } from './config.js';
import { submitTask, getTask, cancelTask, readArtifact } from './jobs.js';
import { metadata } from './metadata.js';

export async function serve(config) {
  const server = new McpServer(metadata, {
    instructions: 'Local implementation is optional. Honor the user\'s per-task choice: when asked to implement directly or avoid local models, do not submit tasks. If taking over a running local task, cancel that task and confirm its terminal state before reviewing any partial patch. Do not cancel unrelated tasks. When delegation is selected, use submit_task. The local worker edits a COPY and returns a patch; it never applies changes to the original project. Preserve task IDs; use get_task(wait_seconds=20) rather than submitting duplicates. ready_for_review means review the patch and actual check results, not that acceptance is proven. Use read_artifact only as needed to keep context small.',
  });
  const wrap = fn => async args => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }] };
    }
  };
  server.registerTool('submit_task', {
    description: 'Delegate one bounded function/module implementation or bug fix when local implementation is selected. Split cross-module work first. Do not use when the user requests primary-model-only execution. Provide a concrete goal, acceptance criteria, scoped allowed_paths, configured check names and absolute workspace. By default at least one check is required. Returns a task ID immediately. Edits a COPY, never the original. request_id is stable across retries. needs_primary is terminal: review its partial patch and failure summary, then take over instead of blindly resubmitting.',
    inputSchema: taskSchema.shape,
  }, wrap(args => submitTask(config, args)));
  server.registerTool('get_task', {
    description: 'Get compact progress or final results of a previously submitted task. Prefer wait_seconds=20 to reduce polling. Does not return full code or logs. ready_for_review still requires primary-model review and patch application.',
    inputSchema: { task_id: z.string(), wait_seconds: z.number().int().min(0).max(25).default(20) },
    annotations: { readOnlyHint: true },
  }, wrap(args => getTask(config, args.task_id, args.wait_seconds)));
  server.registerTool('cancel_task', {
    description: 'Request cancellation of a task. The worker aborts pending inference and configured checks. Query get_task to confirm final status.',
    inputSchema: { task_id: z.string() },
  }, wrap(args => cancelTask(config, args.task_id)));
  server.registerTool('read_artifact', {
    description: 'Read a paginated task artifact: patch, checks, or events. Offsets and limits count JavaScript string characters. Retrieve the patch for review; check logs only when needed.',
    inputSchema: { task_id: z.string(), artifact: z.enum(['patch', 'checks', 'events']), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(24000).default(12000) },
    annotations: { readOnlyHint: true },
  }, wrap(args => readArtifact(config, args.task_id, args.artifact, args.offset, args.limit)));
  server.registerTool('get_capabilities', {
    description: 'List configured model, accepted workspace roots and available check names before delegating. Does not invoke the model.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, wrap(() => ({ model: config.model, workspace_roots: config.workspaceRoots, checks: Object.keys(config.checks),
    default_checks: config.defaultChecks, max_turns: config.maxTurns, max_task_seconds: config.maxTaskSeconds,
    require_checks: config.requireChecks, checks_configured: Object.keys(config.checks).length > 0,
    max_repair_attempts: config.maxRepairAttempts, endpoint_concurrency: 1, temperature: config.temperature,
    reasoning_effort: config.reasoningEffort, max_output_tokens: config.maxOutputTokens,
    max_context_chars: config.maxContextChars, request_timeout_seconds: config.requestTimeoutSeconds,
    writes_original: false, isolation: 'working copy; configured commands run with host user permissions, not an OS sandbox' })));
  await server.connect(new StdioServerTransport());
}

// A targeted MCP regression, not a replacement HumanEval / pass@1 score.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { terminal } from '../src/jobs.js';
import { runCommand } from '../src/process.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = loadConfig(process.argv[2] || process.env.STRATA_CODER_CONFIG || process.env.LOCAL_CODER_CONFIG || path.join(root, 'local-coder.config.json'));
const evaluation = path.resolve(process.argv[3] || path.join(root, '../local-model-eval'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = path.join(root, 'reports', `agent-regression-${stamp}`);
const workRoot = path.join('/private/tmp', `local-coder-regression-${stamp}`);
const harness = path.join(base.stateDir, 'regression-inputs', stamp);
await fs.mkdir(reportDir, { recursive: true });
await fs.mkdir(harness, { recursive: true });
const practical = JSON.parse(await fs.readFile(path.join(evaluation, 'practical_tasks.json'), 'utf8'));
const human = JSON.parse(await fs.readFile(path.join(evaluation, 'humaneval_manifest.json'), 'utf8'));
const all = [...practical, ...human];
const cases = [
  { id: 'Practical/csv_money', mode: 'repair', sample: 'Practical_csv_money' },
  { id: 'HumanEval/160', mode: 'repair', sample: 'HumanEval_160' },
  { id: 'Practical/ttl_lru_cache', mode: 'fresh' },
  { id: 'Practical/deep_config_merge', mode: 'fresh' },
];
const { configPath: _, ...rawConfig } = base;
const results = [];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function saveReport() {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, model_seconds: 0, queue_seconds: 0 };
  for (const r of results) for (const key of Object.keys(usage)) usage[key] += r.job?.usage?.[key] || 0;
  const report = { date: new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'long', timeZone: 'Asia/Shanghai' }).format(new Date()),
    model: base.model, endpoint: base.baseUrl, temperature: base.temperature, reasoning_effort: base.reasoningEffort,
    methodology: 'Two repairs seeded with the original failed outputs; two fresh implementations. Each runs through MCP with original assertions executed outside the editable workspace via the original AST + macOS sandbox checker. Model sees requirements and check failure output, not reference answers or test source. This is a targeted multi-turn regression, not pass@1 or a before/after agent benchmark.',
    configured_limits: { maxRepairAttempts: base.maxRepairAttempts, maxTurns: base.maxTurns, maxOutputTokens: base.maxOutputTokens, requestTimeoutSeconds: base.requestTimeoutSeconds, endpointConcurrency: 1 },
    completed: results.length, total: cases.length, passed: results.filter(r => r.passed).length, usage,
    client_completion_tokens_per_model_second: usage.model_seconds ? usage.completion_tokens / usage.model_seconds : null,
    results };
  await fs.writeFile(path.join(reportDir, 'results.json'), JSON.stringify(report, null, 2));
  const rows = results.map(r => `<tr><td>${escape(r.id)}</td><td>${r.mode === 'repair' ? '修复原失败代码' : '从空实现开始'}</td><td>${r.passed ? '通过' : '未通过'}</td><td>${escape(r.job?.status || 'runner_error')}</td><td>${r.wall_seconds?.toFixed(2) ?? '—'}</td><td>${r.job?.usage?.requests ?? '—'}</td><td>${r.job?.repair_attempts ?? '—'}</td><td>${r.job?.usage?.prompt_tokens ?? '—'} / ${r.job?.usage?.completion_tokens ?? '—'}</td></tr>`).join('');
  const details = results.map(r => `<details><summary>${escape(r.id)}：检查与工件</summary><p><a href="${escape(r.slug)}/changes.patch">补丁</a> · <a href="${escape(r.slug)}/solution.py">最终代码</a> · <a href="${escape(r.slug)}/checks.json">检查记录</a></p><pre>${escape(JSON.stringify({ original_unchanged: r.original_unchanged, reference_passed: r.reference_passed, baseline: r.baseline, applied_check: r.applied_check, error: r.error, job: r.job }, null, 2))}</pre></details>`).join('');
  await fs.writeFile(path.join(reportDir, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地 Agent MCP 回归验证</title><style>body{font-family:system-ui;max-width:1150px;margin:40px auto;padding:0 22px;line-height:1.7;color:#203047}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}th{background:#edf3fa}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:#f6f8fa;padding:14px}aside{background:#fff5dc;padding:16px}details{margin-top:18px}a{color:#1653b0}</style><h1>本地 Agent MCP 回归验证</h1><p>${escape(report.date)} · ${escape(base.model)}</p><h2>结果：${report.passed} / ${report.completed} 通过，共 ${cases.length} 个案例</h2><aside>这是针对性、允许工具调用和测试反馈的回归。两题从原失败代码修复，两题重新实现。不能与原报告的单次生成 46/48 直接比较，也不能证明大型仓库开发成功率或主模型 token 节省比例。</aside><p>输入 ${usage.prompt_tokens} tokens，输出 ${usage.completion_tokens} tokens，共 ${usage.requests} 次模型请求。客户端累计模型请求耗时 ${usage.model_seconds.toFixed(2)} 秒，端点排队 ${usage.queue_seconds.toFixed(2)} 秒。输出包含思考，${report.client_completion_tokens_per_model_second?.toFixed(2) ?? '—'} tok/s 为输出总量 / 客户端模型请求总时长，不采用服务端不一致的 predicted_ms 字段。</p><table><tr><th>案例</th><th>模式</th><th>结果</th><th>任务终态</th><th>MCP 总耗时/秒</th><th>请求数</th><th>失败后修复轮数</th><th>输入 / 输出 tokens</th></tr>${rows}</table><h2>方法与限制</h2><ul><li>temperature=${base.temperature}；reasoning_effort=${escape(base.reasoningEffort ?? 'server default')}；max_tokens=${base.maxOutputTokens}；最多 ${base.maxRepairAttempts} 次失败后修复；请求串行。耗时包含读写、模型往返、检查和 MCP 等待。</li><li>沿用原始验收断言与 AST + macOS sandbox-exec 检查；参考答案先验证通过。测试源文件、参考答案位于工作副本之外，模型可看到检查返回的失败信息。</li><li>只允许修改 src/solution.py，确认原项目未被 Worker 改动，再应用补丁并独立检查。测试结果与原评估文件分开保存。</li><li>仅 4 个 Python 小任务；未测其他语言、大仓库和长上下文。运行顺序和推理缓存会影响耗时。没有运行旧版 Agent 对照组。</li><li>失败后修复轮数从运行检查发现错误后的首次实际修改开始计数；若空壳实现先检查失败，随后的首次实现也计入；所有过程仍受模型调用总轮数限制。</li></ul>${details}<p><a href="results.json">完整结构化数据</a></p></html>`);
}

for (const item of cases) {
  const entry = all.find(x => x.id === item.id);
  assert.ok(entry, `Missing original task ${item.id}`);
  const slug = item.id.replaceAll('/', '_');
  const workspace = path.join(workRoot, slug);
  const taskFile = path.join(harness, `${slug}.json`);
  const artifacts = path.join(reportDir, slug);
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(taskFile, JSON.stringify({ id: entry.id, test: entry.test }));
  const initial = item.mode === 'repair' ? await fs.readFile(path.join(evaluation, 'samples', item.sample, 'solution.py'), 'utf8')
    : '# Implement the requested public API here.\n';
  const checker = ['/usr/bin/python3', '-B', path.join(root, 'scripts/regression-check.py'), evaluation, taskFile];
  // Validate the unchanged assertions/checker with the reference before spending model tokens.
  await fs.writeFile(path.join(workspace, 'src/solution.py'), entry.reference);
  const reference = await runCommand([...checker, '--trusted-reference'], { cwd: workspace, timeoutMs: 20000 });
  assert.equal(reference.exit_code, 0, `Original reference failed: ${reference.output}`);
  await fs.writeFile(path.join(workspace, 'src/solution.py'), initial);
  const baseline = await runCommand(checker, { cwd: workspace, timeoutMs: 20000 });
  assert.notEqual(baseline.exit_code, 0, 'Expected initial candidate to fail the original checks');
  const cfg = { ...rawConfig, workspaceRoots: [workRoot], stateDir: path.join(base.stateDir, 'regression'),
    checks: { acceptance: { command: checker, timeoutSeconds: 20 } }, defaultChecks: ['acceptance'], requireChecks: true };
  const configPath = path.join(harness, `${slug}.config.json`);
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
  const client = new Client({ name: 'local-coder-regression', version: '0.2.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'src/mcp.js'), '--config', configPath], stderr: 'inherit' }));
  const invoke = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const started = performance.now();
  let id;
  const result = { id: item.id, mode: item.mode, slug, reference_passed: true, baseline,
    workspace, config_path: configPath, passed: false };
  try {
    const job = await invoke('submit_task', { workspace, task: `${item.mode === 'repair' ? 'Fix the existing failing implementation' : 'Implement the requested API'} in src/solution.py. Target Python 3.9 standard library. ${item.mode === 'repair' ? 'Read the source, then run acceptance before editing to observe the baseline.' : 'Read the initial source stub, implement the API, then run acceptance.'} Do not change tests. The checker rejects eval/exec/open and network or filesystem access. Do not search outside this workspace.\n\n${entry.prompt}`,
      acceptance: ['Pass the configured acceptance check', 'Preserve specified public signatures', 'Only edit src/solution.py'],
      allowed_paths: ['src/solution.py'], check_names: ['acceptance'], request_id: slug });
    id = job.task_id;
    console.log(JSON.stringify({ event: 'submitted', case: item.id, task_id: id }));
    do {
      result.job = await invoke('get_task', { task_id: id, wait_seconds: 20 });
      console.log(JSON.stringify({ case: item.id, status: result.job.status, stage: result.job.stage, iterations: result.job.iterations, repair_attempts: result.job.repair_attempts }));
    } while (!terminal.has(result.job.status));
    result.wall_seconds = (performance.now() - started) / 1000;
    result.original_unchanged = await fs.readFile(path.join(workspace, 'src/solution.py'), 'utf8') === initial;
    assert.equal(result.original_unchanged, true);
    assert.equal(result.job.snapshot?.files, 1, 'Exactly the initial candidate must be included in the model workspace snapshot');
    if (result.job.artifacts?.patch) await fs.copyFile(result.job.artifacts.patch, path.join(artifacts, 'changes.patch'));
    if (result.job.artifacts?.checks) await fs.copyFile(result.job.artifacts.checks, path.join(artifacts, 'checks.json'));
    if (result.job.status === 'ready_for_review') {
      const patch = result.job.artifacts.patch;
      const preflight = await runCommand(['git', 'apply', '--check', patch], { cwd: workspace });
      assert.equal(preflight.exit_code, 0, preflight.output);
      const applied = await runCommand(['git', 'apply', patch], { cwd: workspace });
      assert.equal(applied.exit_code, 0, applied.output);
      result.applied_check = await runCommand(checker, { cwd: workspace, timeoutMs: 20000 });
      result.passed = result.applied_check.exit_code === 0;
    }
    const finalSource = result.job.artifacts?.patch ? path.join(path.dirname(result.job.artifacts.patch), 'workspace/src/solution.py') : path.join(workspace, 'src/solution.py');
    await fs.copyFile(finalSource, path.join(artifacts, 'solution.py'));
  } catch (error) { result.error = error.message; result.wall_seconds = (performance.now() - started) / 1000; }
  finally {
    if (id) await invoke('cancel_task', { task_id: id }).catch(() => {});
    await client.close();
    results.push(result);
    await saveReport();
  }
}
console.log(JSON.stringify({ event: 'completed', passed: results.filter(r => r.passed).length, total: cases.length, report: path.join(reportDir, 'report.html') }));
if (results.some(r => !r.passed)) process.exitCode = 1;

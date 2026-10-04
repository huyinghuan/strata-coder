import { acquireEndpoint } from './endpoint.js';

export async function modelRequest(config, messages, tools, signal, onPhase = async () => {}) {
  const started = performance.now();
  const lockControl = new AbortController();
  const combined = signal ? AbortSignal.any([signal, lockControl.signal]) : lockControl.signal;
  let release, inferenceStarted;
  const metrics = () => ({ queue_seconds: ((inferenceStarted ?? performance.now()) - started) / 1000,
    model_seconds: inferenceStarted == null ? 0 : (performance.now() - inferenceStarted) / 1000 });
  try {
    await onPhase('waiting_for_endpoint');
    release = await acquireEndpoint(config, combined, error => lockControl.abort(error));
    combined.throwIfAborted();
    inferenceStarted = performance.now();
    await onPhase('model');
    // The per-request timeout starts after acquiring the slot. Queue time is
    // bounded separately by the worker's overall task deadline/cancellation.
    const timeout = AbortSignal.timeout(config.requestTimeoutSeconds * 1000);
    const key = process.env[config.apiKeyEnv];
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: config.model, messages, tools, tool_choice: 'auto',
        ...(config.reasoningEffort != null ? { reasoning_effort: config.reasoningEffort } : {}),
        temperature: config.temperature, max_tokens: config.maxOutputTokens, stream: false }),
      signal: AbortSignal.any([combined, timeout]),
    });
    if (!response.ok) throw new Error(`Model HTTP ${response.status}: ${(await response.text()).slice(0, 1500)}`);
    const body = await response.json();
    const choice = body.choices?.[0];
    if (!choice?.message || (typeof choice.message.content !== 'string' && !choice.message.tool_calls?.length)) {
      throw new Error(`Model returned no text or tool calls (finish_reason=${choice?.finish_reason}).`);
    }
    return { message: choice.message, usage: body.usage || {}, finishReason: choice.finish_reason, metrics: metrics() };
  } catch (error) {
    error.metrics = metrics();
    throw error;
  } finally {
    if (release) await release().catch(() => {});
  }
}

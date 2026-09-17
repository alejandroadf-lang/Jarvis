// OpenTelemetry spans for agent turns and tool calls.
//
// The GenAI semantic conventions define `invoke_agent` and `execute_tool`, and
// the coding agents this company is modelled on already emit them — so a run
// here can be read in the same backend as everything else the founder might
// one day run. McKinsey's "high performers" are separated from the rest partly
// by measuring adoption and quality rather than asserting them; this is the
// plumbing that makes that possible later without a rewrite.
//
// Written against the OTLP/HTTP JSON protocol with plain fetch, no SDK. Same
// reason as the GitHub and Stripe clients: one fewer dependency to keep
// current, and the two shapes this needs are small enough to read in full.
//
// Inert unless OTEL_EXPORTER_OTLP_ENDPOINT is set. That matters more than
// usual here — the company has no observability backend today, and a
// telemetry layer that had to be configured before the app would run would be
// a vendor decision smuggled in as a feature.
//
// Fire-and-forget by construction. An export that blocked a turn, or failed
// one, would make watching the company more dangerous than not watching it.

const CONVENTIONS_VERSION = '1.42.0';

export function isTelemetryConfigured() {
  return Boolean((process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim());
}

function endpoint() {
  const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim().replace(/\/+$/, '');
  return `${base}/v1/traces`;
}

function serviceName() {
  return (process.env.OTEL_SERVICE_NAME || '').trim() || 'jarvis';
}

// OTLP wants 16- and 8-byte ids as lowercase hex. Math.random is fine for
// correlation within a trace; nothing here is a security boundary.
function hex(bytes) {
  let out = '';
  for (let i = 0; i < bytes; i += 1) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return out;
}

export function newTraceId() {
  return hex(16);
}

function toAttributes(attrs = {}) {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => {
      if (typeof value === 'number') {
        return Number.isInteger(value)
          ? { key, value: { intValue: String(value) } }
          : { key, value: { doubleValue: value } };
      }
      if (typeof value === 'boolean') return { key, value: { boolValue: value } };
      return { key, value: { stringValue: String(value) } };
    });
}

/**
 * One finished span, queued for export.
 *
 * Spans are recorded rather than streamed: a turn produces a handful, and a
 * request per span would put this server's latency inside the agent loop.
 */
const pending = [];
let flushTimer = null;

export function recordSpan({ name, traceId, spanId, parentSpanId, startedAt, endedAt, attributes = {}, error = null }) {
  if (!isTelemetryConfigured()) return;
  const start = (startedAt ?? Date.now()) * 1e6;
  const end = (endedAt ?? Date.now()) * 1e6;
  pending.push({
    traceId: traceId || newTraceId(),
    spanId: spanId || hex(8),
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: String(Math.round(start)),
    endTimeUnixNano: String(Math.round(end)),
    attributes: toAttributes(attributes),
    ...(error ? { status: { code: 2, message: String(error).slice(0, 300) } } : { status: { code: 1 } }),
  });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer || !pending.length) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, 2000);
  flushTimer.unref?.();
}

/** Sends whatever has accumulated. Safe to call when there is nothing. */
export async function flush() {
  if (!isTelemetryConfigured() || !pending.length) return false;
  const spans = pending.splice(0, pending.length);
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: toAttributes({ 'service.name': serviceName() }) },
        scopeSpans: [{ scope: { name: 'jarvis', version: CONVENTIONS_VERSION }, spans }],
      },
    ],
  };
  try {
    await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...parseHeaders() },
      body: JSON.stringify(payload),
    });
    return true;
  } catch (err) {
    // Dropped rather than retried. Telemetry that queues on failure becomes a
    // memory leak in exactly the conditions where the server is already unwell.
    console.error('Telemetry export failed, dropping spans:', err.message);
    return false;
  }
}

// OTEL_EXPORTER_OTLP_HEADERS is the standard "k=v,k=v" form most backends
// hand you for auth.
function parseHeaders() {
  const raw = (process.env.OTEL_EXPORTER_OTLP_HEADERS || '').trim();
  if (!raw) return {};
  const out = {};
  for (const pair of raw.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/**
 * The two span shapes the GenAI conventions define for an agent system, named
 * exactly as the spec names them so an off-the-shelf backend groups them
 * without a mapping layer.
 */
export function agentSpan({ agentId, title, model, provider, traceId, spanId, parentSpanId, startedAt, endedAt, usage = {}, error }) {
  recordSpan({
    name: `invoke_agent ${agentId}`,
    traceId,
    spanId,
    parentSpanId,
    startedAt,
    endedAt,
    error,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': agentId,
      'gen_ai.agent.name': title,
      'gen_ai.request.model': model,
      'gen_ai.system': provider,
      'gen_ai.usage.input_tokens': usage.inputTokens,
      'gen_ai.usage.output_tokens': usage.outputTokens,
    },
  });
}

export function toolSpan({ tool, agentId, ok, traceId, parentSpanId, startedAt, endedAt }) {
  recordSpan({
    name: `execute_tool ${tool}`,
    traceId,
    parentSpanId,
    startedAt,
    endedAt,
    error: ok ? null : `${tool} refused or failed`,
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': tool,
      'gen_ai.agent.id': agentId,
    },
  });
}

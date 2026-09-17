// OTLP export for agent turns and tool calls.
//
// Two things are worth guarding here and neither is the wire format. First,
// the module is inert until the founder points it somewhere — a company with
// no observability backend should not be making HTTP requests on every turn.
// Second, a broken collector is not an outage: spans are dropped, not queued
// and not thrown, because telemetry that fails a turn makes watching the
// company more dangerous than not watching it.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let telemetry;
let originalFetch;
const saved = {};

before(async () => {
  for (const key of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_SERVICE_NAME']) {
    saved[key] = process.env[key];
  }
  originalFetch = global.fetch;
  telemetry = await import('../telemetry.js');
});

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = originalFetch;
});

beforeEach(async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  delete process.env.OTEL_SERVICE_NAME;
  global.fetch = originalFetch;
  await telemetry.flush(); // drain anything a previous test left queued
});

function capture() {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  };
  return calls;
}

test('nothing is exported until an endpoint is configured', async () => {
  const calls = capture();
  assert.equal(telemetry.isTelemetryConfigured(), false);
  telemetry.agentSpan({ agentId: 'ceo', title: 'CEO', model: 'claude-sonnet-5', provider: 'anthropic' });
  const flushed = await telemetry.flush();
  assert.equal(flushed, false);
  assert.equal(calls.length, 0, 'no request without an endpoint');
});

test('an agent span exports with the conventional name and attributes', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  const calls = capture();
  telemetry.agentSpan({
    agentId: 'engineering_lead',
    title: 'Engineering Lead',
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    startedAt: 1000,
    endedAt: 1500,
    usage: { inputTokens: 120, outputTokens: 40 },
  });
  assert.ok(await telemetry.flush());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://collector.example/v1/traces');
  const span = calls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, 'invoke_agent engineering_lead');
  const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
  assert.equal(attrs['gen_ai.operation.name'].stringValue, 'invoke_agent');
  assert.equal(attrs['gen_ai.agent.id'].stringValue, 'engineering_lead');
  assert.equal(attrs['gen_ai.usage.input_tokens'].intValue, '120');
  assert.equal(span.status.code, 1);
  // Nanoseconds, as OTLP wants them — not the milliseconds that went in.
  assert.equal(span.startTimeUnixNano, '1000000000');
  assert.equal(span.endTimeUnixNano, '1500000000');
});

test('a failed tool call exports as an error span', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  const calls = capture();
  telemetry.toolSpan({ tool: 'deploy_code', agentId: 'engineering_lead', ok: false, traceId: telemetry.newTraceId() });
  await telemetry.flush();
  const span = calls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, 'execute_tool deploy_code');
  assert.equal(span.status.code, 2);
  assert.match(span.status.message, /deploy_code/);
});

test('a trailing slash on the endpoint does not double up', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example/';
  const calls = capture();
  telemetry.toolSpan({ tool: 'log_revenue', agentId: 'cfo', ok: true });
  await telemetry.flush();
  assert.equal(calls[0].url, 'https://collector.example/v1/traces');
});

test('spans in one flush share a request, and the queue empties', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  const calls = capture();
  telemetry.toolSpan({ tool: 'a', agentId: 'cfo', ok: true });
  telemetry.toolSpan({ tool: 'b', agentId: 'cfo', ok: true });
  await telemetry.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.resourceSpans[0].scopeSpans[0].spans.length, 2);
  assert.equal(await telemetry.flush(), false, 'a second flush has nothing to send');
});

test('OTEL_EXPORTER_OTLP_HEADERS becomes request headers', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'api-key=abc123,x-tenant=jarvis';
  const calls = capture();
  telemetry.toolSpan({ tool: 'a', agentId: 'cfo', ok: true });
  await telemetry.flush();
  assert.equal(calls[0].options.headers['api-key'], 'abc123');
  assert.equal(calls[0].options.headers['x-tenant'], 'jarvis');
});

test('the service name is configurable and defaults to jarvis', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  let calls = capture();
  telemetry.toolSpan({ tool: 'a', agentId: 'cfo', ok: true });
  await telemetry.flush();
  let resource = calls[0].body.resourceSpans[0].resource.attributes;
  assert.equal(resource.find((a) => a.key === 'service.name').value.stringValue, 'jarvis');

  process.env.OTEL_SERVICE_NAME = 'jarvis-prod';
  calls = capture();
  telemetry.toolSpan({ tool: 'a', agentId: 'cfo', ok: true });
  await telemetry.flush();
  resource = calls[0].body.resourceSpans[0].resource.attributes;
  assert.equal(resource.find((a) => a.key === 'service.name').value.stringValue, 'jarvis-prod');
});

// The property that matters: a collector that is down must not surface as a
// failed agent turn.
test('a collector that refuses the export does not throw', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  telemetry.toolSpan({ tool: 'a', agentId: 'cfo', ok: true });
  assert.equal(await telemetry.flush(), false);
  // And the failed spans are dropped rather than retried forever.
  const calls = capture();
  assert.equal(await telemetry.flush(), false);
  assert.equal(calls.length, 0);
});

test('trace and span ids are 32 and 16 hex characters', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  const calls = capture();
  telemetry.toolSpan({ tool: 'a', agentId: 'cfo', ok: true });
  await telemetry.flush();
  const span = calls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.match(telemetry.newTraceId(), /^[0-9a-f]{32}$/);
});

test('a parent span id is carried when given and omitted when not', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  const calls = capture();
  telemetry.agentSpan({ agentId: 'cfo', title: 'CFO', model: 'm', provider: 'anthropic', parentSpanId: 'aabbccddeeff0011' });
  telemetry.agentSpan({ agentId: 'ceo', title: 'CEO', model: 'm', provider: 'anthropic' });
  await telemetry.flush();
  const [child, root] = calls[0].body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(child.parentSpanId, 'aabbccddeeff0011');
  assert.equal('parentSpanId' in root, false);
});

// Undefined attributes are dropped rather than exported as the string
// "undefined", which is what a backend would otherwise index and chart.
test('missing usage numbers are left out, not stringified', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example';
  const calls = capture();
  telemetry.agentSpan({ agentId: 'cfo', title: 'CFO', model: 'm', provider: 'anthropic' });
  await telemetry.flush();
  const span = calls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  const keys = span.attributes.map((a) => a.key);
  assert.equal(keys.includes('gen_ai.usage.input_tokens'), false);
});

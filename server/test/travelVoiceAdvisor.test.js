// The advisor is one agent with a domain brief and, at most, two read-only
// tools. Pinned here: the language is stated in the prompt rather than
// inferred; the tool loop closes every tool_use with a tool_result; a tool
// failure is a result the model can explain; the tools exist only with
// Amadeus credentials; and every call is metered.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let advisor;
let spend;
const saved = {};
const KEYS = ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'TRAVEL_VOICE_MODEL', 'TRAVEL_VOICE_LLM_PROVIDER', 'DAILY_SPEND_CAP_USD', 'ANTHROPIC_API_KEY', 'IONOS_API_KEY'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-advisor-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  advisor = await import('../travelVoice/advisor.js');
  spend = await import('../spend.js');
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = 'an-key';
});

function textResponse(text, usage = { input_tokens: 100, output_tokens: 50 }) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage };
}

function stubClient(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push({ ...request, messages: [...request.messages] });
        const next = responses.shift();
        if (!next) throw new Error('no more stubbed responses');
        return typeof next === 'function' ? next(request) : next;
      },
    },
  };
}

test('the language is stated in the system prompt, and the reply comes back', async () => {
  const client = stubClient([textResponse('Utilice FXP para crear el TST.')]);
  const before = spend.getSpendToday();

  const result = await advisor.runAdvisorTurn({ anthropic: client, text: '¿Cómo valoro el PNR?', language: 'es' });

  assert.equal(result.reply, 'Utilice FXP para crear el TST.');
  assert.equal(result.language, 'es');
  const system = client.calls[0].system.map((b) => b.text).join('\n');
  assert.match(system, /Reply entirely in Spanish \(Español\)/);
  assert.match(system, /Amadeus/);
  assert.equal(client.calls[0].tools, undefined, 'no tools without Amadeus credentials');
  assert.ok(spend.getSpendToday() > before, 'the call is metered');
  assert.equal(result.messages.length, 2, 'user turn plus assistant turn');
  assert.equal(result.messages[0].content, '¿Cómo valoro el PNR?');
});

test('French and English are stated the same way', async () => {
  const fr = stubClient([textResponse('Oui.')]);
  await advisor.runAdvisorTurn({ anthropic: fr, text: 'x', language: 'fr' });
  assert.match(fr.calls[0].system.map((b) => b.text).join(), /Reply entirely in French \(Français\)/);

  const en = stubClient([textResponse('Yes.')]);
  await advisor.runAdvisorTurn({ anthropic: en, text: 'x', language: 'unknown' });
  assert.match(en.calls[0].system.map((b) => b.text).join(), /Reply entirely in English/);
});

test('history is carried in front of the new message', async () => {
  const client = stubClient([textResponse('Second answer.')]);
  const history = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
  ];
  const result = await advisor.runAdvisorTurn({ anthropic: client, history, text: 'second question', language: 'en' });
  assert.equal(client.calls[0].messages.length, 3);
  assert.equal(client.calls[0].messages[2].content, 'second question');
  assert.equal(result.messages.length, 4);
});

test('with Amadeus credentials the tools are offered and a tool round closes with a tool_result', async () => {
  process.env.AMADEUS_CLIENT_ID = 'id';
  process.env.AMADEUS_CLIENT_SECRET = 'secret';

  const client = stubClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'search_flight_offers', input: { origin: 'MAD', destination: 'CDG', departureDate: '2026-10-01' } },
      ],
      usage: { input_tokens: 200, output_tokens: 40 },
    },
    (request) => {
      const last = request.messages[request.messages.length - 1];
      assert.equal(last.role, 'user');
      assert.equal(last.content[0].type, 'tool_result');
      assert.equal(last.content[0].tool_use_id, 'tu_1');
      assert.match(last.content[0].content, /189\.40/);
      return textResponse('The cheapest is 189.40 euros with Iberia, non-stop.');
    },
  ]);

  const tools = async (name, input) => {
    assert.equal(name, 'search_flight_offers');
    assert.equal(input.origin, 'MAD');
    return [{ price: { total: '189.40', currency: 'EUR' } }];
  };

  const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'Cheapest MAD to CDG on 1 October?', language: 'en', tools });

  assert.equal(client.calls[0].tools.length, 2);
  assert.deepEqual(client.calls[0].tools.map((t) => t.name), ['lookup_location', 'search_flight_offers']);
  assert.equal(result.reply, 'The cheapest is 189.40 euros with Iberia, non-stop.');
  assert.deepEqual(result.toolCalls, [{ name: 'search_flight_offers', input: { origin: 'MAD', destination: 'CDG', departureDate: '2026-10-01' } }]);
  assert.equal(result.usage.inputTokens, 300, 'both rounds are counted');
});

test('a tool failure becomes an error result the model can explain, not an exception', async () => {
  process.env.AMADEUS_CLIENT_ID = 'id';
  process.env.AMADEUS_CLIENT_SECRET = 'secret';

  const client = stubClient([
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_2', name: 'lookup_location', input: { keyword: 'Paris' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    (request) => {
      const last = request.messages[request.messages.length - 1];
      assert.equal(last.content[0].is_error, true);
      assert.match(last.content[0].content, /sandbox down/);
      return textResponse("I can't reach the fare search right now.");
    },
  ]);

  const result = await advisor.runAdvisorTurn({
    anthropic: client,
    text: 'Airports in Paris?',
    language: 'en',
    tools: async () => {
      throw new Error('sandbox down');
    },
  });
  assert.match(result.reply, /can't reach/);
});

test('over the daily cap nothing is asked', async () => {
  process.env.DAILY_SPEND_CAP_USD = '0.0000001';
  spend.recordSpend(1);
  const client = stubClient([textResponse('should not run')]);
  await assert.rejects(() => advisor.runAdvisorTurn({ anthropic: client, text: 'x', language: 'en' }), /Daily spend cap reached/);
  assert.equal(client.calls.length, 0);
});

test('without any brain configured the advisor says which keys would give it one', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(() => advisor.runAdvisorTurn({ anthropic: stubClient([]), text: 'x', language: 'en' }), /No advisor model is configured/);
});

test('a named brain is used for the turn, and its model is reported', async () => {
  process.env.IONOS_API_KEY = 'io-key';
  let seen;
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Utilisez FXP.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8 } }),
    };
  };
  try {
    const client = stubClient([]);
    const result = await advisor.runAdvisorTurn({ anthropic: client, provider: 'ionos', text: 'Comment valoriser ?', language: 'fr' });
    assert.equal(client.calls.length, 0, 'Anthropic was not asked');
    assert.equal(result.provider, 'ionos');
    assert.equal(result.model, 'meta-llama/Llama-3.3-70B-Instruct');
    assert.equal(result.reply, 'Utilisez FXP.');
    assert.match(seen.url, /openai\.inference\.de-txl\.ionos\.com\/v1\/chat\/completions$/);
    assert.equal(seen.auth, 'Bearer io-key');
    assert.equal(seen.body.messages[0].role, 'system');
    assert.match(seen.body.messages[0].content, /Reply entirely in French/);
    assert.match(seen.body.messages[0].content, /Amadeus/);
    assert.equal(seen.body.messages[1].content, 'Comment valoriser ?');
    assert.equal(seen.body.tools, undefined);
    assert.ok(result.usage.costUsd > 0, 'priced at the IONOS rate');
  } finally {
    global.fetch = originalFetch;
  }
});

test('naming a brain that has no key is refused rather than swapped', async () => {
  await assert.rejects(() => advisor.runAdvisorTurn({ anthropic: stubClient([]), provider: 'ionos', text: 'x', language: 'en' }), /IONOS AI Model Hub \(EU\) is not configured/);
  await assert.rejects(() => advisor.runAdvisorTurn({ anthropic: stubClient([]), provider: 'hal9000', text: 'x', language: 'en' }), /Unknown llm provider "hal9000"/);
});

test('the domain brief covers what agencies actually ring about', () => {
  const brief = advisor.__testing.DOMAIN_BRIEF;
  for (const entry of ['FXP', 'FXB', 'TTP', 'RT', 'FQN', 'TST', 'PNR', 'NDC', 'EU261', 'BSP', 'TIMATIC']) {
    assert.ok(brief.includes(entry), `brief should mention ${entry}`);
  }
  assert.match(brief, /Spanish, French and English/);
  assert.match(brief, /Never invent/);
});

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
  assert.deepEqual(client.calls[0].tools.map((t) => t.name), ['request_human'], 'only the handoff tool without Amadeus credentials');
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

  assert.equal(client.calls[0].tools.length, 3);
  assert.deepEqual(client.calls[0].tools.map((t) => t.name), ['request_human', 'lookup_location', 'search_flight_offers']);
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
    assert.deepEqual(seen.body.tools.map((t) => t.function.name), ['request_human'], 'the handoff tool travels to every brain');
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

// --- money only from a source ---------------------------------------------------

test('an amount with no tool result and no caller mention behind it is corrected once', async () => {
  const client = stubClient([
    textResponse('The change fee is 150 euros plus the fare difference.'),
    (request) => {
      const last = request.messages[request.messages.length - 1];
      assert.equal(last.role, 'user');
      assert.match(last.content, /150 euros/, 'the correction names the invented amount');
      assert.match(last.content, /came from no search result/);
      assert.equal(request.tools, undefined, 'no tools on the correction');
      return textResponse('The change fee is set by the fare rule: check FQN on category 31 and quote what it returns, plus any fare difference.');
    },
  ]);

  const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'What is the change fee on this ticket?', language: 'en' });

  assert.equal(client.calls.length, 2);
  assert.deepEqual(result.grounding, { ungrounded: ['150 euros'], corrected: true, stillUngrounded: [] });
  assert.match(result.reply, /category 31/);
});

test('an amount the caller said, or a tool returned, is not questioned', async () => {
  const echoed = stubClient([textResponse('Sí, los 300 euros que pagó el cliente se reembolsan según la categoría 33.')]);
  const a = await advisor.runAdvisorTurn({ anthropic: echoed, text: 'El cliente pagó 300 € y quiere el reembolso', language: 'es' });
  assert.equal(echoed.calls.length, 1, 'no correction');
  assert.equal(a.grounding, null);
  assert.deepEqual(a.amounts, ['300 euros']);

  process.env.AMADEUS_CLIENT_ID = 'id';
  process.env.AMADEUS_CLIENT_SECRET = 'secret';
  const searched = stubClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'search_flight_offers', input: { origin: 'MAD', destination: 'CDG', departureDate: '2026-10-01' } }], usage: { input_tokens: 1, output_tokens: 1 } },
    textResponse('La más barata sale a 189,40 € con Iberia.'),
  ]);
  const b = await advisor.runAdvisorTurn({
    anthropic: searched, text: 'La más barata MAD CDG', language: 'es',
    tools: async () => [{ price: { total: '189.40', currency: 'EUR' } }],
  });
  assert.equal(searched.calls.length, 2, 'the tool round and the answer, nothing more');
  assert.equal(b.grounding, null);
});

test('the correction can be switched off, and the ungrounded amount is still recorded', async () => {
  process.env.TRAVEL_VOICE_GROUNDING_RETRY = 'false';
  try {
    const client = stubClient([textResponse('Compensation is €600 for that route.')]);
    const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'Delayed 5 hours MAD to JFK, what compensation?', language: 'en' });
    assert.equal(client.calls.length, 1);
    assert.deepEqual(result.grounding, { ungrounded: ['€600'], corrected: false });
  } finally {
    delete process.env.TRAVEL_VOICE_GROUNDING_RETRY;
  }
});

test('the prompt pins the formal register and forbids reading the person', () => {
  const es = advisor.__testing.languageInstruction('es');
  assert.match(es, /de usted en todo momento/);
  const fr = advisor.__testing.languageInstruction('fr');
  assert.match(fr, /Vouvoyez/);
  assert.match(advisor.__testing.DOMAIN_BRIEF, /MONEY ONLY FROM A SOURCE/);
  assert.match(advisor.__testing.DOMAIN_BRIEF, /Never assert that a particular passenger is or is not entitled/);
  assert.match(advisor.__testing.DOMAIN_BRIEF, /Never infer, mention or act on the caller's emotional state/);
});

test('the advisor can ask for a person, and the turn says so', async () => {
  const client = stubClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Entiendo que quiere reclamar.' },
        { type: 'tool_use', id: 'tu_h', name: 'request_human', input: { reason: 'Caller disputes an ADM and wants a decision.' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    (request) => {
      const last = request.messages[request.messages.length - 1];
      assert.equal(last.content[0].type, 'tool_result');
      assert.match(last.content[0].content, /A person will continue/);
      return textResponse('Paso su caso a una persona que le responderá por aquí.');
    },
  ]);
  const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'Quiero reclamar este ADM', language: 'es', tools: async () => { throw new Error('should not be called'); } });
  assert.deepEqual(result.handoff, { reason: 'Caller disputes an ADM and wants a decision.' });
  assert.match(result.reply, /una persona/);
});


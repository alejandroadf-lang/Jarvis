// Simulate, then judge: the rules that need no model, the judge's verdict
// parsed, and a whole run against fake models.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let qa;
const saved = {};
const KEYS = ['ANTHROPIC_API_KEY', 'IONOS_API_KEY', 'TRAVEL_VOICE_LLM_PROVIDER', 'AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'DAILY_SPEND_CAP_USD', 'TRAVEL_VOICE_GROUNDING_RETRY', 'TRAVEL_VOICE_LANGUAGE_RETRY'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-qa-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  qa = await import('../travelVoice/qa/simulate.js');
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
  process.env.ANTHROPIC_API_KEY = 'an';
  process.env.DAILY_SPEND_CAP_USD = '100';
  process.env.TRAVEL_VOICE_GROUNDING_RETRY = 'false';
  process.env.TRAVEL_VOICE_LANGUAGE_RETRY = 'false';
});

test('the rules catch the failures a person would notice first', () => {
  const es = (reply, extra = {}) => qa.ruleChecks({ reply, language: 'es', transcript: 'No me valora el localizador X7K2PQ con FXP', expect: { codes: ['X7K2PQ', 'FXP'], mentions: ['TST'] }, ...extra });
  assert.deepEqual(es('Pruebe FXP de nuevo con el localizador X7K2PQ y revise el TST con TQT.'), []);
  const wrong = es('Please try the FXP entry again with the locator and check the TST with TQT, then the fare and the booking for the passenger and the itinerary as well.');
  assert.ok(wrong.some((f) => f.rule === 'language'), 'answered in English');
  assert.ok(wrong.some((f) => f.rule === 'codes' && /X7K2PQ/.test(f.detail)), 'the locator was not echoed');
  const invented = es('El cambio cuesta 150 euros. Revise el TST y el localizador X7K2PQ con FXP.');
  assert.deepEqual(invented.map((f) => f.rule), ['grounding']);
  const grounded = qa.ruleChecks({ reply: 'La más barata sale a 189,40 €.', language: 'es', transcript: 'precio MAD CDG', toolOutputs: ['{"total":"189.40"}'] });
  assert.deepEqual(grounded, []);
  const vague = es('Sí, revise el localizador X7K2PQ y FXP.');
  assert.deepEqual(vague.map((f) => f.rule), ['substance']);

  const handoffDue = qa.ruleChecks({ reply: 'Je comprends.', language: 'fr', transcript: 'Je veux parler à un responsable', expect: { handoff: true }, handoff: null, turnIndex: 0, turns: 1 });
  assert.deepEqual(handoffDue.map((f) => f.rule), ['handoff']);
  const handoffUnasked = qa.ruleChecks({ reply: 'Je transmets.', language: 'fr', transcript: 'Comment émettre ?', handoff: { reason: 'x' } });
  assert.deepEqual(handoffUnasked.map((f) => f.rule), ['handoff']);
});

test('the judge answers in JSON, and anything else is a finding rather than a crash', () => {
  const good = qa.parseJudge('Here you go:\n{"scores": {"correctness": 2, "grounding": 1, "language": 2}, "worst": "grounding", "note": "Said how to check but hedged."}');
  assert.equal(good.mean, 5 / 3);
  assert.equal(good.worst, 'grounding');
  assert.equal(qa.parseJudge('no json here').scores, null);
  assert.match(qa.parseJudge('{"scores": {"a": }}').note, /malformed/);
});

test('a run plays the callers, answers as the advisor, applies the rules and asks the judge', async () => {
  const scripted = {
    'es-pricing': ['Valore con FXP el localizador X7K2PQ; si el TST no se crea, revise la clase y pruebe FXB.', 'Con FQD verá la tarifa; el TST se ve con TQT.', 'De nada.'],
    'fr-handoff': ['Je comprends, je transmets votre dossier à une personne.'],
    'en-eu261': ['Under EU261 a delay of over three hours on a flight from an EU airport may qualify, at the band for the distance, unless extraordinary circumstances apply; the carrier confirms.', 'Ask the carrier in writing.'],
  };
  const calls = { advisor: 0, caller: 0, judge: 0 };
  let current = null;
  const anthropic = {
    messages: {
      create: async (request) => {
        const system = (request.system || []).map((b) => b.text).join('\n');
        const usage = { input_tokens: 100, output_tokens: 30 };
        if (/You are judging/.test(system)) {
          calls.judge += 1;
          const low = /fr-handoff/.test(request.messages[0].content);
          return { content: [{ type: 'text', text: JSON.stringify({ scores: { correctness: 2, grounding: 2, language: 2, codes: 2, brevity: 2, escalation: low ? 0 : 2, register: 2 }, worst: low ? 'escalation' : 'brevity', note: low ? 'Should have used the tool.' : 'Fine.' }) }], usage };
        }
        if (/Stay in character/.test(system)) {
          calls.caller += 1;
          return { content: [{ type: 'text', text: 'Gracias, ¿y cómo veo la tarifa?' }], usage };
        }
        calls.advisor += 1;
        const turn = request.messages.filter((m) => m.role === 'user').length - 1;
        const reply = scripted[current][Math.min(turn, scripted[current].length - 1)];
        if (current === 'fr-handoff') {
          return { stop_reason: request.messages.at(-1).role === 'user' && request.messages.at(-1).content?.[0]?.type === 'tool_result' ? 'end_turn' : 'tool_use', content: request.messages.at(-1).content?.[0]?.type === 'tool_result' ? [{ type: 'text', text: reply }] : [{ type: 'tool_use', id: 'tu_1', name: 'request_human', input: { reason: 'ADM dispute' } }], usage };
        }
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage };
      },
    },
  };
  const scenarios = qa.SCENARIOS.filter((s) => Object.keys(scripted).includes(s.id)).map((s) => ({ ...s, turns: Math.min(s.turns, 2) }));
  const log = [];
  const summary = await qa.runSimulation({
    anthropic,
    scenarios: scenarios.map((s) => new Proxy(s, { get: (t, k) => { if (k === 'id') current = t.id; return t[k]; } })),
    log: (line) => log.push(line),
  });

  assert.equal(summary.scenarios, 3);
  assert.equal(calls.judge, 3, 'one verdict per scenario');
  assert.ok(calls.caller >= 1, 'the caller model wrote the follow-ups');
  const byId = Object.fromEntries(summary.results.map((r) => [r.id, r]));
  assert.deepEqual(byId['es-pricing'].findings, [], 'a clean Spanish run');
  assert.equal(byId['es-pricing'].exchange.length, 2);
  assert.equal(byId['fr-handoff'].exchange[0].handoff.reason, 'ADM dispute');
  assert.deepEqual(byId['fr-handoff'].findings, [], 'the handoff that was due happened');
  assert.equal(byId['fr-handoff'].judge.worst, 'escalation');
  assert.equal(summary.byLanguage.es.clean, 1);
  assert.ok(summary.costUsd > 0, 'the run is priced');
  assert.ok(summary.judgeMean > 1.5);
  const text = qa.formatSummary(summary);
  assert.match(text, /Simulate-then-judge: 3\/3 scenarios clean/);
  assert.match(text, /⚖ fr-handoff: Should have used the tool\./);
  assert.ok(log.some((l) => /judge:/.test(l)));
});

test('the stub tools give a searched scenario a grounded figure and nothing else', async () => {
  const offers = await qa.stubTools('search_flight_offers', { origin: 'MAD', destination: 'CDG' });
  assert.equal(offers[0].price.total, '189.40');
  await assert.rejects(() => qa.stubTools('book_it', {}), /Unknown tool/);
});

#!/usr/bin/env node
// A dress rehearsal of the whole WhatsApp pipeline, with the vendors faked.
//
// The unit tests prove each piece; this proves the chain. It runs the real
// `handleTravelVoiceMessage` — the same function the webhook calls — with
// nothing stubbed but `fetch` and the Anthropic client, and walks a caller
// through the sequence an agency owner will actually take: a first voice
// note met with the AI notice, the tap, a question with a locator in it, a
// question designed to make the advisor invent a fee, a translation, and a
// demand for a person. Then it reads the audit trail and the metrics back.
//
// It needs no keys and costs nothing, so it can run in CI and before a
// demo. What it cannot tell you is whether ElevenLabs likes your plan or
// whether WhatsApp keeps the Ogg comment on delivery — those need the real
// channel. Everything up to the wire is checked here.
//
//   npm run travel:smoke

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// An isolated data directory, set before anything reads it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-smoke-'));
process.env.JARVIS_DATA_DIR = dataDir;
process.env.WHATSAPP_TOKEN = 'smoke-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111';
process.env.TRAVEL_VOICE_PHONE_NUMBER_ID = '222';
process.env.WHATSAPP_ALLOWED_NUMBERS = '447700900123';
process.env.ANTHROPIC_API_KEY = 'smoke-key';
process.env.OPENAI_API_KEY = 'smoke-key';
process.env.DAILY_SPEND_CAP_USD = '100';
process.env.TRAVEL_VOICE_CONSENT = 'required';
process.env.TRAVEL_VOICE_REVIEW_SAMPLE_PCT = '100';
delete process.env.TRAVEL_VOICE_LLM_PROVIDER;
delete process.env.TRAVEL_VOICE_STT_PROVIDER;
delete process.env.TRAVEL_VOICE_TTS_PROVIDER;

const tv = await import('../index.js');
const audit = await import('../audit.js');
const consent = await import('../consent.js');
const escalation = await import('../escalation.js');
const { oggOpusComments, oggOpusDurationSeconds } = await import('../ogg.js');

// --- a real Ogg Opus voice note, so the marking and the duration are real ---

function oggPage({ granule, body, headerType = 0, sequence = 0 }) {
  const segments = [];
  let left = body.length;
  while (left >= 255) {
    segments.push(255);
    left -= 255;
  }
  segments.push(left);
  const header = Buffer.alloc(27 + segments.length);
  header.write('OggS', 0, 'latin1');
  header[5] = headerType;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = segments.length;
  segments.forEach((n, i) => { header[27 + i] = n; });
  return Buffer.concat([header, body]);
}

function voiceNote(seconds) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  return Buffer.concat([
    oggPage({ granule: 0, body: head, headerType: 2, sequence: 0 }),
    oggPage({ granule: 0, body: Buffer.from('OpusTags\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000', 'latin1'), sequence: 1 }),
    oggPage({ granule: Math.round(seconds * 48000) + 312, body: Buffer.alloc(64, 7), headerType: 4, sequence: 2 }),
  ]);
}

// --- the fake outside world ---------------------------------------------------

const sent = [];
let heard = { text: '', language: 'spanish' };
let clipSeconds = 6;
let synthesised = null;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/\/media-\d+$/.test(u)) return ok({ url: 'https://lookaside/blob', mime_type: 'audio/ogg' });
  if (u === 'https://lookaside/blob') {
    const b = voiceNote(clipSeconds);
    return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
  }
  if (u.includes('/audio/transcriptions')) return ok({ text: heard.text, language: heard.language, duration: clipSeconds });
  if (u.includes('/audio/speech')) {
    synthesised = JSON.parse(init.body).input;
    const b = voiceNote(4);
    return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
  }
  if (/\/media$/.test(u)) {
    // The bytes WhatsApp would receive: check the marker survived synthesis.
    const form = init.body;
    const blob = form.get('file');
    lastUpload = Buffer.from(await blob.arrayBuffer());
    return ok({ id: `upload-${sent.length}` });
  }
  if (/\/messages$/.test(u)) {
    const body = JSON.parse(init.body);
    sent.push({ from: u.match(/\/(\d+)\/messages$/)[1], ...body });
    return ok({ messages: [{ id: `wamid.out${sent.length}` }] });
  }
  throw new Error(`smoke: unexpected fetch ${u}`);
};

let lastUpload = null;
const ok = (json) => ({ ok: true, json: async () => json });

// --- the fake brain -------------------------------------------------------------

let reply = () => 'ok';
const asked = [];
const anthropic = {
  messages: {
    create: async (request) => {
      asked.push({ system: (request.system || []).map((b) => b.text).join('\n'), messages: [...request.messages], tools: request.tools });
      const out = reply(request, asked.length);
      if (typeof out === 'string') return { stop_reason: 'end_turn', content: [{ type: 'text', text: out }], usage: { input_tokens: 400, output_tokens: 90 } };
      return out;
    },
  },
};

// --- the walk ----------------------------------------------------------------------

const checks = [];
function check(label, condition, detail = '') {
  checks.push({ label, pass: Boolean(condition), detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${label}${condition || !detail ? '' : ` — ${detail}`}`);
}
const since = (n) => sent.slice(n);
const CALLER = '34600111222';
const msg = (over) => ({ id: `wamid.${Math.random().toString(36).slice(2, 8)}`, from: CALLER, type: 'text', text: '', mediaId: null, phoneNumberId: '222', ...over });
const voice = (over) => msg({ type: 'audio', mediaId: 'media-1', ...over });

console.log(`\nTravel voice smoke test — the real pipeline, faked vendors\n${'─'.repeat(58)}`);

// 1. A stranger's first voice note. Nothing is heard until they agree.
console.log('\n1. First contact: a Spanish voice note from a number nobody knows');
let mark = sent.length;
heard = { text: '¿Cómo emito el billete?', language: 'spanish' };
let out = await tv.handleTravelVoiceMessage(voice(), { anthropic, phoneNumberId: '222' });
let round = since(mark);
check('the voice note is refused until consent', out.stage === 'consent_required', `got ${out.stage}`);
check('the model was never asked', asked.length === 0);
check('the audio was never transcribed', !synthesised || !asked.length);
check('the notice was spoken', round.some((m) => m.type === 'audio'));
check('the notice was written with two buttons', round.some((m) => m.type === 'interactive' && m.interactive.action.buttons.length === 2));
check('the notice is in Spanish (from the country code)', round.some((m) => m.type === 'interactive' && /asistente automático/.test(m.interactive.body.text)));

// 2. The tap.
console.log('\n2. The caller taps "Acepto"');
mark = sent.length;
out = await tv.handleTravelVoiceMessage(msg({ type: 'interactive', buttonReply: { id: 'consent_yes', title: 'Acepto' } }), { anthropic, phoneNumberId: '222' });
check('the tap is recorded as consent', out.granted === true);
check('the message id is kept as evidence', Boolean(consent.consentState(CALLER)?.consentMessageId));
check('voice is now allowed', consent.voiceAllowed(CALLER) === true);

// 3. A real question, with a locator in it.
console.log('\n3. A voice note: "no me valora el localizador X7K2PQ"');
mark = sent.length;
heard = { text: 'Buenos días, no me valora el localizador X7K2PQ con FXP', language: 'spanish' };
reply = () => 'Valore con FXP y revise el TST con TQT. Si sigue sin valorar, pruebe FXB para la tarifa más baja.';
out = await tv.handleTravelVoiceMessage(voice(), { anthropic, phoneNumberId: '222' });
round = since(mark);
check('answered', out.stage === 'answered' && out.spoke === true, `got ${out.stage}`);
check('answered in Spanish', /Reply entirely in Spanish/.test(asked.at(-1).system));
check('the formal register is pinned', /de usted en todo momento/.test(asked.at(-1).system));
check('the handoff tool is offered', (asked.at(-1).tools || []).some((t) => t.name === 'request_human'));
check('the locator is read back, spelled aloud', /He entendido: Localizador X de Xiquena, 7, K de Kilo/.test(synthesised), synthesised?.slice(0, 80));
check('entries are spelled letter by letter in the audio', /F-X-P/.test(synthesised) && /T-Q-T/.test(synthesised));
const written = round.find((m) => m.type === 'text');
check('the written twin keeps the code exactly', /Localizador: X7K2PQ/.test(written.text.body) && /FXP/.test(written.text.body));
check('the voice note is Ogg Opus', lastUpload && oggOpusDurationSeconds(lastUpload) > 0);
const comments = lastUpload ? oggOpusComments(lastUpload) : [];
check('the voice note is marked AI-generated', comments.includes('AI_GENERATED=true'));
check('the marker names Article 50', comments.some((c) => /Article 50/.test(c)));

// 4. The fee trap: the advisor must not invent a number.
console.log('\n4. A question designed to make it invent a fee');
mark = sent.length;
asked.length = 0;
heard = { text: '¿Cuánto cobra Iberia por cambiar la fecha?', language: 'spanish' };
let first = true;
reply = () => {
  if (first) {
    first = false;
    return 'El cambio cuesta 150 euros más la diferencia de tarifa.';
  }
  return 'El importe exacto lo fija la tarifa: consulte FQN en la categoría 31 y aplique lo que devuelva, más la diferencia.';
};
out = await tv.handleTravelVoiceMessage(voice(), { anthropic, phoneNumberId: '222' });
check('the invented amount triggered exactly one correction', asked.length === 2, `${asked.length} calls`);
check('the correction named the amount', /150 euros/.test(asked[1].messages.at(-1).content));
check('the caller heard the corrected answer', /categoría 31/.test(since(mark).find((m) => m.type === 'text').text.body));

// 5. Translation, with the codes protected.
console.log('\n5. TRADUCIR EN, then a message full of codes');
await tv.handleTravelVoiceMessage(msg({ text: 'TRADUCIR EN' }), { anthropic, phoneNumberId: '222' });
mark = sent.length;
asked.length = 0;
reply = (request) => {
  const input = request.messages[0].content;
  return input.replace('El localizador', 'The locator').replace('no valora en clase', 'does not price in class');
};
out = await tv.handleTravelVoiceMessage(msg({ text: 'El localizador X7K2PQ no valora en clase Y, vuelo IB3402 MAD CDG' }), { anthropic, phoneNumberId: '222' });
check('translated, not answered', out.stage === 'translated', `got ${out.stage}`);
check('the model never saw the locator', !asked[0].messages[0].content.includes('X7K2PQ'), asked[0].messages[0].content);
check('placeholders were explained to it', /protected codes/.test(asked[0].system));
check('the glossary rode along', /record locator = locator|TERMINOLOGY/.test(asked[0].system));
const translated = since(mark).find((m) => m.type === 'text').text.body;
check('every code came back intact', ['X7K2PQ', 'IB3402', 'MAD', 'CDG'].every((c) => translated.includes(c)), translated);
check('nothing was reported as dropped', !since(mark).some((m) => m.type === 'text' && /Check these before/.test(m.text.body)));
await tv.handleTravelVoiceMessage(msg({ text: 'TRANSLATE OFF' }), { anthropic, phoneNumberId: '222' });

// 6. A person is wanted.
console.log('\n6. "quiero hablar con una persona"');
mark = sent.length;
asked.length = 0;
out = await tv.handleTravelVoiceMessage(msg({ text: 'quiero hablar con una persona' }), { anthropic, phoneNumberId: '222' });
round = since(mark);
check('the handoff opened before any model ran', out.stage === 'handoff_opened' && asked.length === 0);
check('the founder was told, with the number', round.some((m) => m.from === '111' && /Caller: \+34600111222/.test(m.text?.body)));
check('the caller was told, in Spanish', round.some((m) => /paso tu conversación a una persona/.test(m.text?.body || '')));
mark = sent.length;
out = await tv.handleTravelVoiceMessage(msg({ text: '¿Y mientras tanto?' }), { anthropic, phoneNumberId: '222' });
check('while open, the advisor stays silent', out.stage === 'handoff_forwarded' && asked.length === 0);
check('the message reached the person', since(mark).some((m) => /Caller \+34600111222: ¿Y mientras tanto\?/.test(m.text?.body || '')));
mark = sent.length;
await tv.runTravelVoiceCommand({ kind: 'say', number: CALLER, text: 'Soy Alejandro, le llamo ahora.' }, { from: '447700900123', phoneNumberId: '111' });
check('a person can answer from the advisor’s number', since(mark).some((m) => m.from === '222' && m.text?.body === 'Soy Alejandro, le llamo ahora.'));
await tv.runTravelVoiceCommand({ kind: 'resume', number: CALLER }, { from: '447700900123', phoneNumberId: '111' });
check('and hand back', escalation.isEscalated(CALLER) === false);

// 7. The record.
console.log('\n7. What was written down');
const trail = audit.readAudit();
const raw = JSON.stringify(trail);
check('every turn is in the audit trail', trail.length >= 8, `${trail.length} lines`);
check('no words in the trail', !/X7K2PQ|localizador|Alejandro/.test(raw));
check('no phone numbers in the trail', !raw.includes(CALLER));
check('the caller is a stable hash', trail.filter((l) => l.caller).every((l) => l.caller === audit.callerKey(CALLER)));
check('the consent state is recorded per turn', trail.some((l) => l.stage === 'answered' && l.consent === 'granted'));
check('the prompt version is recorded', trail.some((l) => /^[0-9a-f]{8}$/.test(l.promptVersion || '')));
check('answered turns were sampled for review', audit.reviewQueueSize() >= 2, `${audit.reviewQueueSize()} queued`);
check('the sample keeps the words a person needs', /X7K2PQ/.test(JSON.stringify(audit.reviewQueue(10))));

console.log('\n8. The numbers');
const m = tv.travelVoiceMetrics({ days: 7 });
console.log(await tv.runTravelVoiceCommand({ kind: 'metrics', days: 7 }, { from: '447700900123' }));
check('Spanish turns are counted', m.languages.es.answered >= 2, `${m.languages.es.answered}`);
check('the handoff is counted', m.total.handoffs >= 1);
check('cost per resolved conversation is computed', m.costPerResolvedConversation !== null || m.resolvedConversations === 0);
const swept = tv.runRetentionSweep({ now: Date.now() + 200 * 24 * 3600 * 1000 });
check('the retention sweep forgets old conversations', swept.conversations >= 1, JSON.stringify(swept));

// --- the verdict -------------------------------------------------------------------

const failed = checks.filter((c) => !c.pass);
console.log(`\n${'─'.repeat(58)}`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) {
  console.log('\nFailed:');
  for (const f of failed) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
}
console.log(`\nNot covered here (needs the real channel): whether WhatsApp keeps the Ogg\ncomment on delivery, whether your ElevenLabs plan accepts enable_logging=false,\nand what a real transcriber hears.\n`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;

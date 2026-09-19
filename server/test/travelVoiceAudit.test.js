// The trail, the sample, the clocks and the numbers.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let audit;
let settings;
const saved = {};
const KEYS = ['TRAVEL_VOICE_RETENTION_DAYS', 'TRAVEL_VOICE_REVIEW_RETENTION_DAYS', 'TRAVEL_VOICE_AUDIT_RETENTION_DAYS', 'TRAVEL_VOICE_REVIEW_SAMPLE_PCT', 'TRAVEL_VOICE_SESSION_CAP_USD', 'TRAVEL_VOICE_AUDIT_SALT'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-audit-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  audit = await import('../travelVoice/audit.js');
  settings = await import('../travelVoice/settings.js');
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
  audit.__resetAuditForTests();
  settings.__resetSettingsForTests();
});

const DAY = 24 * 60 * 60 * 1000;

test('the trail keeps everything about a turn except the words, and the caller is a salted hash', () => {
  audit.recordAudit({ kind: 'turn', stage: 'answered', caller: audit.callerKey('+34 600 111 222'), language: 'es', transcript: 'SECRET QUESTION', reply: 'SECRET ANSWER', detail: 'secret', costUsd: 0.02, providers: { stt: 'openai' } });
  const [line] = audit.readAudit();
  assert.equal(line.stage, 'answered');
  assert.equal(line.costUsd, 0.02);
  assert.equal(line.transcript, undefined);
  assert.equal(line.reply, undefined);
  assert.equal(line.detail, undefined);
  const raw = fs.readFileSync(path.join(tmpDir, 'travelVoiceAudit.jsonl'), 'utf8');
  assert.ok(!raw.includes('SECRET'), 'no words in the file');
  assert.ok(!raw.includes('34600111222'), 'no number in the file');
  assert.equal(line.caller, audit.callerKey('34600111222'), 'formatting does not change the hash');
  process.env.TRAVEL_VOICE_AUDIT_SALT = 'other';
  assert.notEqual(audit.callerKey('34600111222'), line.caller, 'another salt, another hash');
});

test('a few per cent of turns are sampled with their words, and a verdict clears one', () => {
  const never = { random: () => 0.99 };
  const always = { random: () => 0 };
  assert.equal(audit.maybeSample({ from: '34600111222', transcript: 'q', reply: 'a' }, never), null, '3% by default');
  const item = audit.maybeSample({ from: '34600111222', language: 'es', transcript: 'q', reply: 'a', flags: { drift: true } }, always);
  assert.match(item.id, /^r[a-z0-9]+$/);
  assert.equal(item.transcript, 'q');
  assert.equal(item.caller, audit.callerKey('34600111222'));
  assert.equal(audit.reviewQueueSize(), 1);
  assert.deepEqual(audit.reviewQueue(5).map((i) => i.id), [item.id]);

  process.env.TRAVEL_VOICE_REVIEW_SAMPLE_PCT = '0';
  assert.equal(audit.maybeSample({ from: 'x' }, always), null, 'off at zero');
  settings.setOverride('sample', 100);
  assert.ok(audit.maybeSample({ from: 'x', transcript: 'q2', reply: 'a2' }, never), 'the dial beats the variable');

  const done = audit.markReviewed(item.id, { verdict: 'bad', note: 'wrong category', by: '447700900123' });
  assert.equal(done.verdict, 'bad');
  assert.equal(audit.reviewQueueSize(), 1);
  assert.equal(audit.reviewVerdicts().length, 1);
  assert.equal(audit.markReviewed(item.id, { verdict: 'ok' }), null, 'once');
  const review = audit.readAudit().find((l) => l.kind === 'review');
  assert.equal(review.verdict, 'bad');
  assert.equal(review.note, undefined, 'the note stays in the review file, not the trail');
});

test('one conversation has a daily cap, separate from the daily cap on everything', () => {
  assert.equal(audit.sessionCapUsd(), 1);
  assert.equal(audit.sessionUnderCap('whatsapp-1'), true);
  audit.recordSessionSpend('whatsapp-1', 0.6);
  audit.recordSessionSpend('whatsapp-1', 0.5);
  assert.equal(audit.sessionUnderCap('whatsapp-1'), false);
  assert.equal(audit.sessionUnderCap('whatsapp-2'), true, 'another caller is unaffected');
  settings.setOverride('cap', 5);
  assert.equal(audit.sessionUnderCap('whatsapp-1'), true, 'raised from the phone');
  assert.equal(audit.recordSessionSpend('whatsapp-1', -1), 1.1, 'a refund is not a thing');
});

test('the numbers are per language, and a conversation is resolved when it ended well', () => {
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  const a = audit.callerKey('1'); const b = audit.callerKey('2'); const c = audit.callerKey('3');
  audit.recordAudit({ at: at(1), kind: 'turn', stage: 'answered', caller: a, language: 'es', voice: true, costUsd: 0.10, timings: { sttMs: 500, llmMs: 2000, ttsMs: 500 } });
  audit.recordAudit({ at: at(1), kind: 'turn', stage: 'answered', caller: a, language: 'es', voice: false, costUsd: 0.02, timings: { llmMs: 1000 }, drift: { detected: 'en', corrected: true } });
  audit.recordAudit({ at: at(2), kind: 'turn', stage: 'answered', caller: b, language: 'fr', voice: true, costUsd: 0.12, timings: { sttMs: 400, llmMs: 1600, ttsMs: 400 }, grounding: { ungrounded: ['150 €'], corrected: false }, readBack: ['X7K2PQ'] });
  audit.recordAudit({ at: at(2), kind: 'turn', stage: 'handoff_opened', caller: b, language: 'fr' });
  audit.recordAudit({ at: at(3), kind: 'turn', stage: 'failed', caller: c, language: 'en', costUsd: 0.01 });
  audit.recordAudit({ at: at(3), kind: 'turn', stage: 'consent_required', caller: c, language: 'en' });
  audit.recordAudit({ at: at(24 * 10), kind: 'turn', stage: 'answered', caller: c, language: 'en', costUsd: 5 }, 'ten days ago, outside the window');

  const m = audit.metrics({ days: 7, now });
  assert.equal(m.total.turns, 6);
  assert.equal(m.total.answered, 3);
  assert.ok(Math.abs(m.total.costUsd - 0.25) < 1e-9);
  assert.equal(m.languages.es.answered, 2);
  assert.equal(m.languages.es.voice, 1);
  assert.equal(m.languages.es.wrongLanguage, 1);
  assert.equal(m.languages.es.wrongLanguageFixed, 1);
  assert.equal(m.languages.es.wrongLanguageRate, 0.5);
  assert.equal(m.languages.es.avgLatencyMs, 2000, '(3000 + 1000) / 2');
  assert.equal(m.languages.fr.ungrounded, 1);
  assert.equal(m.languages.fr.readBacks, 1);
  assert.equal(m.languages.fr.entityIssueRate, 1);
  assert.equal(m.languages.fr.handoffs, 1);
  assert.equal(m.languages.en.failed, 1);
  assert.equal(m.languages.en.consentRequired, 1);
  assert.equal(m.languages.en.answered, 0);
  assert.equal(m.languages.en.costPerAnswer, null);
  assert.equal(m.conversations, 3);
  assert.equal(m.resolvedConversations, 1, 'only the Spanish one: French handed off, English failed');
  assert.ok(Math.abs(m.costPerResolvedConversation - 0.25) < 1e-9, 'the whole period’s spend over the resolved ones');
});

test('the clocks: transcripts go at the retention period, the sample later, the trail last', () => {
  const now = Date.now();
  audit.recordAudit({ at: new Date(now - 6 * 365 * DAY).toISOString(), kind: 'turn', stage: 'answered', language: 'es' });
  audit.recordAudit({ at: new Date(now - 1 * DAY).toISOString(), kind: 'turn', stage: 'answered', language: 'es' });
  const always = { random: () => 0 };
  const old = audit.maybeSample({ from: '1', transcript: 'old', reply: 'old' }, always);
  // Age the sampled item by hand.
  const file = path.join(tmpDir, 'travelVoiceReview.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.queue.find((i) => i.id === old.id).at = new Date(now - 400 * DAY).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  audit.maybeSample({ from: '2', transcript: 'new', reply: 'new' }, always);

  let swept = null;
  const removed = audit.sweepRetention({ now, sweepConversations: (cutoff) => { swept = cutoff; return 4; } });
  assert.equal(removed.conversations, 4);
  assert.equal(removed.reviewItems, 1);
  assert.equal(removed.auditLines, 1);
  assert.ok(Math.abs(now - 180 * DAY - swept) < 1000, 'transcripts: 180 days by default');
  assert.equal(audit.reviewQueueSize(), 1);
  const kinds = audit.readAudit().map((l) => l.kind);
  assert.deepEqual(kinds, ['turn', 'sweep'], 'the sweep itself is in the trail');

  process.env.TRAVEL_VOICE_RETENTION_DAYS = '30';
  audit.sweepRetention({ now, sweepConversations: (cutoff) => { swept = cutoff; return 0; } });
  assert.ok(Math.abs(now - 30 * DAY - swept) < 1000);
});

test('the trail counts the caller’s codes and amounts rather than keeping them', () => {
  audit.recordAudit({
    kind: 'turn',
    stage: 'answered',
    language: 'es',
    readBack: ['X7K2PQ', '075-1234567890'],
    dropped: ['IB3402'],
    amounts: ['189,40 €'],
    protectedCodes: ['MAD', 'CDG'],
    grounding: { ungrounded: ['150 euros'], corrected: false, stillUngrounded: ['150 euros'] },
  });
  const [line] = audit.readAudit();
  assert.equal(line.readBackCount, 2);
  assert.equal(line.droppedCount, 1);
  assert.equal(line.amountCount, 1);
  assert.equal(line.protectedCount, 2);
  assert.deepEqual(line.grounding, { corrected: false, ungroundedCount: 1, stillUngroundedCount: 1 });
  assert.equal(line.readBack, undefined);
  assert.equal(line.dropped, undefined);
  const raw = fs.readFileSync(path.join(tmpDir, 'travelVoiceAudit.jsonl'), 'utf8');
  for (const secret of ['X7K2PQ', '075-1234567890', 'IB3402', '189,40', '150 euros', 'MAD']) {
    assert.ok(!raw.includes(secret), `the trail still holds ${secret}`);
  }
});

test('the metrics read the counted fields, and the arrays an older trail carries', () => {
  const now = Date.now();
  const at = new Date(now - 3600 * 1000).toISOString();
  audit.recordAudit({ at, kind: 'turn', stage: 'answered', language: 'es', readBackCount: 1, droppedCount: 1, grounding: { ungroundedCount: 1, corrected: false } });
  // A line written before the redaction existed, appended by hand.
  fs.appendFileSync(path.join(tmpDir, 'travelVoiceAudit.jsonl'), `${JSON.stringify({ at, kind: 'turn', stage: 'answered', language: 'fr', readBack: ['ABC123'], dropped: ['IB1'], grounding: { ungrounded: ['9 €'], corrected: false } })}\n`);
  const m = audit.metrics({ days: 1, now });
  assert.equal(m.languages.es.readBacks, 1);
  assert.equal(m.languages.es.droppedCodes, 1);
  assert.equal(m.languages.es.ungrounded, 1);
  assert.equal(m.languages.fr.readBacks, 1, 'an older line still counts');
  assert.equal(m.languages.fr.droppedCodes, 1);
  assert.equal(m.languages.fr.ungrounded, 1);
});

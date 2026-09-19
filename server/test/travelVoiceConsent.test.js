// The record behind the first message: who was told, in which words, and
// what they tapped.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let consent;
let settings;
const saved = {};
const KEYS = ['TRAVEL_VOICE_CONSENT', 'TRAVEL_VOICE_PRIVACY_URL', 'TRAVEL_VOICE_RETENTION_DAYS'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-consent-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  consent = await import('../travelVoice/consent.js');
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
  consent.__resetConsentForTests();
  settings.__resetSettingsForTests();
});

test('required is the default, and the phone dial beats the environment', () => {
  assert.equal(consent.consentMode(), 'required');
  process.env.TRAVEL_VOICE_CONSENT = 'notice';
  assert.equal(consent.consentMode(), 'notice');
  settings.setOverride('consent', 'off');
  assert.equal(consent.consentMode(), 'off');
  process.env.TRAVEL_VOICE_CONSENT = 'nonsense';
  settings.clearOverride('consent');
  assert.equal(consent.consentMode(), 'required', 'an unknown value is not a lowered bar');
});

test('a caller needs the notice once per version, and voice waits for the tap', () => {
  assert.equal(consent.needsDisclosure('+34 600 111 222'), true);
  assert.equal(consent.voiceAllowed('34600111222'), false);
  consent.recordDisclosure('34600111222', { language: 'es', messageId: 'wamid.n', spoken: true });
  assert.equal(consent.needsDisclosure('+34 600 111 222'), false, 'formatting does not matter');
  assert.equal(consent.voiceAllowed('34600111222'), false, 'told is not agreed');
  consent.recordConsent('34600111222', { granted: true, messageId: 'wamid.t', buttonId: 'consent_yes' });
  assert.equal(consent.voiceAllowed('34600111222'), true);
  const state = consent.consentState('34600111222');
  assert.equal(state.consentMessageId, 'wamid.t');
  assert.equal(state.disclosureMessageId, 'wamid.n');

  process.env.TRAVEL_VOICE_CONSENT = 'notice';
  assert.equal(consent.voiceAllowed('33600000000'), true, 'notice mode never gates');
  process.env.TRAVEL_VOICE_CONSENT = 'off';
  assert.equal(consent.needsDisclosure('33600000000'), false);
});

test('the wording carries the retention period and the privacy link, in each language', () => {
  process.env.TRAVEL_VOICE_RETENTION_DAYS = '90';
  process.env.TRAVEL_VOICE_PRIVACY_URL = 'https://example.com/privacy';
  const es = consent.disclosureText('es');
  assert.match(es, /máximo 3 meses/);
  assert.match(es, /https:\/\/example\.com\/privacy/);
  assert.match(consent.disclosureText('fr'), /au plus 3 mois/);
  assert.match(consent.disclosureText('en'), /at most 3 months/);
  delete process.env.TRAVEL_VOICE_RETENTION_DAYS;
  assert.match(consent.disclosureText('en'), /at most 6 months/, 'six months by default');
  for (const l of ['es', 'fr', 'en']) {
    const payload = consent.disclosurePayload(l);
    assert.ok(payload.interactive.body.text.length <= 1024, `${l} notice fits a WhatsApp body`);
    assert.ok(consent.spokenDisclosure(l).split(' ').length < 60, `${l} spoken notice is short`);
  }
});

test('a tap is recognised by its id, never by its wording; forget requests in three languages', () => {
  assert.deepEqual(consent.parseConsentReply({ id: 'consent_yes', title: 'whatever' }), { granted: true });
  assert.deepEqual(consent.parseConsentReply({ id: 'consent_no', title: 'Acepto' }), { granted: false });
  assert.equal(consent.parseConsentReply({ id: 'other', title: 'Acepto' }), null);
  assert.equal(consent.parseConsentReply(null), null);
  for (const word of ['BORRAR', 'borrar', 'Supprimer', 'oublie-moi', 'delete', 'forget me']) assert.equal(consent.isForgetRequest(word), true, word);
  assert.equal(consent.isForgetRequest('delete the segment'), false);
});

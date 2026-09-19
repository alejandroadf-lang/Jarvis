#!/usr/bin/env node
// The three things no fake can answer.
//
// The smoke test proves the chain end to end without a single credential.
// Three questions it cannot reach, because they are facts about somebody
// else's servers rather than about this code:
//
//   1. Does the AI-generated marker survive Meta? A container comment is
//      the machine-readable half of the Article 50 disclosure, and it
//      survives a file being saved and forwarded — but not a transcode.
//      Whether WhatsApp transcodes is not documented and not guessable, so
//      this uploads a marked voice note through the real media API and
//      downloads it back to look.
//
//   2. Does this ElevenLabs plan honour enable_logging=false? The
//      zero-retention flag is per-plan. A plan that rejects it fails the
//      synthesis, which on a demo looks like the voice being broken, and
//      a plan that ignores it keeps the caller's words. Both are worth
//      knowing before an agency hears about it.
//
//   3. What does a real transcriber hear? Only real audio answers that,
//      which is what the capture below is for: it turns the voice notes a
//      demo actually produced into fixtures the bench can score.
//
// Costs a few cents of media and one short synthesis. Run it once per
// deployment, and again whenever a vendor or a plan changes.
//
//   npm run travel:verify

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { uploadMedia, downloadMedia } from '../../channels/whatsapp.js';
import { synthesizeSpeech, canSpeak } from '../speech.js';
import { oggOpusComments, isOgg, oggOpusDurationSeconds } from '../ogg.js';
import { elevenLabsVoice, elevenLabsZeroRetention } from '../providers/tts.js';
import { resolveProvider } from '../providers/index.js';
import { capturedFixtures, captureDir } from './capture.js';

const results = [];
function say(label, verdict, detail = '') {
  results.push({ label, verdict, detail });
  const mark = verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '·';
  console.log(`${mark} ${label}${detail ? `\n    ${detail}` : ''}`);
}

console.log('\nTravel voice — what only the real vendors can answer\n' + '─'.repeat(56));

// --- 1. Does the marker survive Meta? ------------------------------------------

console.log('\n1. The AI-generated marker through WhatsApp media');
if (!process.env.WHATSAPP_TOKEN || !(process.env.TRAVEL_VOICE_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID)) {
  say('marker round trip', 'skip', 'WHATSAPP_TOKEN and a phone number id are needed.');
} else if (!canSpeak()) {
  say('marker round trip', 'skip', 'No speech provider configured, so there is nothing to mark.');
} else {
  try {
    const spoken = await synthesizeSpeech('Prueba de marca de audio sintético.', { language: 'es', format: 'opus' });
    const before = oggOpusComments(spoken.buffer) || [];
    say(
      'the voice note leaves here marked',
      before.includes('AI_GENERATED=true') ? 'pass' : 'fail',
      before.length ? before.join(' · ') : 'no comments in the file at all'
    );

    const phoneNumberId = process.env.TRAVEL_VOICE_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const mediaId = await uploadMedia(spoken.buffer, { mimeType: spoken.mimeType, filename: spoken.filename, phoneNumberId });
    const back = await downloadMedia(mediaId);
    const after = oggOpusComments(back.buffer) || [];
    const sameBytes = back.buffer.equals(spoken.buffer);

    say(
      'it comes back from Meta still marked',
      after.includes('AI_GENERATED=true') ? 'pass' : 'fail',
      sameBytes
        ? 'byte-for-byte identical — Meta stored it untouched.'
        : after.length
          ? `re-encoded but the comments survived: ${after.join(' · ')}`
          : `re-encoded and the comments were stripped. Ogg ${isOgg(back.buffer) ? 'still' : 'no longer'}, ${oggOpusDurationSeconds(back.buffer) ?? '?'}s. The spoken disclosure is doing the work; an in-signal watermark is the fix.`
    );
    console.log(
      after.includes('AI_GENERATED=true')
        ? '    Note: storage kept it. Delivery to a handset may still transcode; the surest check is to send yourself one and inspect the saved file.'
        : '    Article 50 is still met by the spoken and written disclosure on first contact; only the machine-readable half is lost.'
    );
  } catch (err) {
    say('marker round trip', 'fail', err.message);
  }
}

// --- 2. Does the plan honour zero retention? -------------------------------------

console.log('\n2. ElevenLabs zero retention');
if (!elevenLabsVoice.configured()) {
  say('enable_logging=false', 'skip', 'ELEVENLABS_API_KEY is not set.');
} else if (!elevenLabsZeroRetention()) {
  say('enable_logging=false', 'skip', 'Turned off here by ELEVENLABS_ZERO_RETENTION=false.');
} else {
  try {
    const out = await elevenLabsVoice.synthesize('Prueba.', { language: 'es', format: 'opus' });
    say(
      'the plan accepts enable_logging=false',
      out.buffer?.length ? 'pass' : 'fail',
      `${out.buffer.length} bytes came back, so the flag was not rejected. ElevenLabs enforces it per plan — confirm on their dashboard that this key is on a tier where it applies.`
    );
  } catch (err) {
    const rejected = /enable_logging|logging|zero retention|not allowed|403|422/i.test(err.message);
    say(
      'the plan accepts enable_logging=false',
      'fail',
      rejected
        ? `Rejected: ${err.message}\n    Set ELEVENLABS_ZERO_RETENTION=false to keep the voice working, and treat the caller's words as retained by the vendor in your DPIA.`
        : err.message
    );
  }
}

// --- 3. Real audio for the bench ---------------------------------------------------

console.log('\n3. Fixtures for the ears benchmark');
const fixtures = capturedFixtures();
if (!fixtures.length) {
  say(
    'captured voice notes',
    'skip',
    `None yet. Send TRAVEL CAPTURE ON from your phone, have a few real voice notes answered, then TRAVEL CAPTURE OFF.\n    They land in ${captureDir()} as audio plus the transcript, ready for: npm run travel:bench -- "${captureDir()}"`
  );
} else {
  const byLanguage = {};
  for (const f of fixtures) byLanguage[f.language || '??'] = (byLanguage[f.language || '??'] || 0) + 1;
  say(
    'captured voice notes',
    'pass',
    `${fixtures.length} in ${captureDir()} (${Object.entries(byLanguage).map(([l, n]) => `${l} ${n}`).join(', ')}).\n    Check each .txt says what was actually said, then: npm run travel:bench -- "${captureDir()}"`
  );
  const ears = ['openai', 'elevenlabs', 'deepgram', 'assemblyai'].filter((id) => {
    try {
      return Boolean(resolveProvider('stt', id));
    } catch {
      return false;
    }
  });
  say('ears available to compare', ears.length > 1 ? 'pass' : 'skip', ears.length ? ears.join(', ') : 'only one — set another key to make it a comparison');
}

// --- the verdict ---------------------------------------------------------------------

const failed = results.filter((r) => r.verdict === 'fail');
const skipped = results.filter((r) => r.verdict === 'skip');
console.log('\n' + '─'.repeat(56));
console.log(`${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped.`);
if (failed.length) console.log('\nEach failure above says what to do about it; none of them stops the advisor answering.');
process.exitCode = failed.length ? 1 : 0;

// Knowing when the caller has stopped: the decision that makes a live call
// feel like a conversation or like a machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnDetector, rms, toSamples, __testing } from '../travelVoice/live/turnTaking.js';

const RATE = 16000;
const FRAME = 320; // 20 ms

function frame(level) {
  const samples = new Int16Array(FRAME);
  // Alternating so the RMS is exactly `level` rather than a sine's 0.707.
  for (let i = 0; i < FRAME; i++) samples[i] = i % 2 ? level : -level;
  return Buffer.from(samples.buffer);
}

function feed(detector, level, ms) {
  const events = [];
  for (let i = 0; i < ms / 20; i++) events.push(...detector.push(frame(level)));
  return events;
}

test('a frame is measured by its energy, whatever shape it arrives in', () => {
  assert.equal(Math.round(rms(new Int16Array([1000, -1000, 1000, -1000]))), 1000);
  assert.equal(rms(new Int16Array(0)), 0);
  assert.equal(toSamples(frame(500)).length, FRAME);
  assert.equal(toSamples(Buffer.from([1, 2, 3])).length, 1, 'an odd byte is not half a sample');
});

test('speech starts after enough of it, and ends after enough silence', () => {
  const d = createTurnDetector({ sampleRate: RATE });
  assert.deepEqual(feed(d, 5, 400), [], 'a quiet line says nothing');

  const brief = feed(d, 4000, 100);
  assert.deepEqual(brief, [], 'a hundred milliseconds is not yet speech');
  const started = feed(d, 4000, 60);
  assert.equal(started.length, 1);
  assert.equal(started[0].type, 'speech-start');
  assert.equal(started[0].bargeIn, false);
  assert.equal(d.state().inSpeech, true);

  feed(d, 4000, 1000);
  assert.deepEqual(feed(d, 5, 600), [], 'a gap mid-sentence is not the end');
  const ended = feed(d, 5, 200);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].type, 'speech-end');
  assert.ok(ended[0].speechMs >= 1000);
  assert.equal(d.state().inSpeech, false);
});

test('a blip that never became speech is a false start, not a turn', () => {
  const d = createTurnDetector({ sampleRate: RATE });
  feed(d, 4000, 160); // enough to announce
  const out = feed(d, 5, 800);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'false-start', 'under the minimum utterance');
});

test('a finished sentence shortens the wait', () => {
  const quick = createTurnDetector({ sampleRate: RATE });
  feed(quick, 4000, 600);
  quick.noteTranscript('¿Cómo emito el billete?', { isFinal: true });
  const ended = feed(quick, 5, 400);
  assert.equal(ended.length, 1, 'a question mark means they are done');
  assert.equal(ended[0].finalised, true);

  const patient = createTurnDetector({ sampleRate: RATE });
  feed(patient, 4000, 600);
  patient.noteTranscript('y entonces el localizador', { isFinal: true });
  assert.deepEqual(feed(patient, 5, 400), [], 'an unfinished one waits the full gap');
  assert.equal(feed(patient, 5, 320).length, 1);

  const partial = createTurnDetector({ sampleRate: RATE });
  feed(partial, 4000, 600);
  partial.noteTranscript('¿Cómo emito?', { isFinal: false });
  assert.deepEqual(feed(partial, 5, 400), [], 'a partial transcript decides nothing');
});

test('barge-in is held to a higher bar than a first word', () => {
  // The same audio into two detectors that differ only in whether the
  // advisor is speaking. Level 300 sits between the two bars: speech on a
  // quiet line, not enough to interrupt — which is what the advisor's own
  // voice sounds like coming back through a microphone with no echo
  // cancellation on it.
  const settle = (d) => feed(d, 5, 400);

  const quiet = createTurnDetector({ sampleRate: RATE });
  settle(quiet);
  assert.equal(feed(quiet, 300, 200)[0]?.type, 'speech-start', 'it is speech when nobody is speaking');

  const busy = createTurnDetector({ sampleRate: RATE });
  settle(busy);
  busy.setSpeaking(true);
  assert.deepEqual(feed(busy, 300, 200), [], 'the advisor does not interrupt itself');

  const loud = createTurnDetector({ sampleRate: RATE });
  settle(loud);
  loud.setSpeaking(true);
  const barged = feed(loud, 9000, 300);
  assert.equal(barged.length, 1);
  assert.equal(barged[0].type, 'speech-start');
  assert.equal(barged[0].bargeIn, true, 'a real voice over the top does');
});

test('an endless utterance is cut off rather than carried for ever', () => {
  const d = createTurnDetector({ sampleRate: RATE, maxUtteranceMs: 1000 });
  const events = feed(d, 4000, 1400);
  assert.equal(events.filter((e) => e.type === 'too-long').length, 1, 'it gave up and answered what it had');
  // They are still talking, so what follows is a fresh utterance rather
  // than a continuation nobody will ever be told the end of.
  assert.equal(events.filter((e) => e.type === 'speech-start').length, 2);
  assert.equal(events.at(-1).type, 'speech-start');
  assert.equal(d.state().inSpeech, true);
});

test('the floor follows the room, and never falls so far that hiss is speech', () => {
  const d = createTurnDetector({ sampleRate: RATE });
  const start = d.noiseFloor();
  feed(d, 600, 2000); // a noisy office
  assert.ok(d.noiseFloor() > start, 'it learned the room is loud');

  const quiet = createTurnDetector({ sampleRate: RATE });
  feed(quiet, 0, 5000);
  assert.ok(quiet.noiseFloor() >= 1);
  assert.deepEqual(feed(quiet, 100, 1000), [], 'faint hiss is still not speech');
  assert.equal(__testing.DEFAULTS.absoluteFloor > 0, true);
});

test('reset clears a half-heard turn without forgetting the room', () => {
  const d = createTurnDetector({ sampleRate: RATE });
  feed(d, 4000, 400);
  assert.equal(d.state().inSpeech, true);
  const floor = d.noiseFloor();
  d.reset();
  assert.equal(d.state().inSpeech, false);
  assert.equal(d.noiseFloor(), floor);
});

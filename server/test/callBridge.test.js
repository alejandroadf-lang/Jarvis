// The bridge between the phone and the model. Tested against a fake Twilio
// and a fake realtime endpoint, because the three things most likely to be
// wrong here are all audible and none of them can be heard in a unit test
// unless the sockets are real:
//
//   1. Interruption has two halves. Cancelling the model is not enough —
//      Twilio keeps playing what it has already buffered, so the caller talks
//      over a voice answering a question from several seconds ago.
//   2. Nothing can go back to Twilio before its `start` event supplies the
//      stream SID.
//   3. A slow answer has to actually arrive. The caller was told it was being
//      asked, so silence afterwards is a promise broken without a trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import { answerCallTwiml, attachCallStream } from '../realtime/twilioBridge.js';

const ENV = ['VOICE_CALLS', 'CALL_ALLOWED_NUMBERS', 'OPENAI_API_KEY', 'CALL_MAX_SECONDS', 'OPENAI_REALTIME_URL', 'TWILIO_AUTH_TOKEN'];

function withEnv(values, run) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  return Promise.resolve(run()).finally(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

// --- TwiML ------------------------------------------------------------------------------

test('an allowed caller is connected to the media stream', async () => {
  await withEnv({ VOICE_CALLS: 'true', CALL_ALLOWED_NUMBERS: '66812345678' }, () => {
    const xml = answerCallTwiml({ from: '+66812345678', host: 'jarvis.example.com' });
    assert.match(xml, /<Connect><Stream url="wss:\/\/jarvis\.example\.com\/api\/calls\/stream"/);
    assert.match(xml, /name="from" value="\+66812345678"/, 'the caller is passed through to the stream');
  });
});

test('a language chosen on the keypad rides into the stream; none chosen, no parameter', async () => {
  await withEnv({ VOICE_CALLS: 'true', CALL_ALLOWED_NUMBERS: '66812345678' }, () => {
    const chosen = answerCallTwiml({ from: '+66812345678', host: 'h', language: 'Spanish' });
    assert.match(chosen, /<Parameter name="language" value="Spanish"\/>/);
    const plain = answerCallTwiml({ from: '+66812345678', host: 'h' });
    assert.doesNotMatch(plain, /name="language"/, 'absent means the desk opens in its default');
  });
});

test('a refused caller hears the reason and is hung up on', async () => {
  await withEnv({ VOICE_CALLS: 'true', CALL_ALLOWED_NUMBERS: '66812345678' }, () => {
    const xml = answerCallTwiml({ from: '+15551234567', host: 'jarvis.example.com' });
    assert.match(xml, /<Say>.*not on the call allowlist.*<\/Say>/);
    assert.match(xml, /<Hangup\/>/);
    assert.doesNotMatch(xml, /<Stream/, 'and never reaches the model');
  });
});

test('a caller ID with XML in it cannot break out of the TwiML', async () => {
  await withEnv({ VOICE_CALLS: 'true', CALL_ALLOWED_NUMBERS: '66812345678' }, () => {
    const xml = answerCallTwiml({ from: '"><Say>pwned</Say><!--', host: 'h' });
    assert.doesNotMatch(xml, /<Say>pwned<\/Say>/);
  });
});

// --- The live bridge --------------------------------------------------------------------

/**
 * A fake OpenAI realtime endpoint plus a server with the bridge attached.
 * Returns everything a test needs to drive a call from the Twilio side and
 * watch what the model was told.
 */
async function callHarness({ askTheTeam = async () => 'The team says yes.' } = {}) {
  const fromModel = [];          // events the bridge sent to the "model"
  const toTwilio = [];           // events the bridge sent back to "Twilio"
  const ended = [];
  let modelSocket = null;

  // Stand in for wss://api.openai.com/v1/realtime.
  const fakeOpenAI = new WebSocketServer({ port: 0 });
  await once(fakeOpenAI, 'listening');
  const openAIPort = fakeOpenAI.address().port;
  fakeOpenAI.on('connection', (ws) => {
    modelSocket = ws;
    ws.on('message', (raw) => fromModel.push(JSON.parse(raw.toString())));
  });

  // The bridge opens its session on Twilio's `start` event, so the fake
  // endpoint and a key have to be in place before the harness returns.
  process.env.OPENAI_REALTIME_URL = `ws://127.0.0.1:${openAIPort}`;
  process.env.OPENAI_API_KEY = 'test-key';

  const server = http.createServer();
  attachCallStream(server, { askTheTeam, onCallEnded: (e) => ended.push(e) });
  server.listen(0);
  await once(server, 'listening');

  const twilio = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/calls/stream`);
  await once(twilio, 'open');
  twilio.on('message', (raw) => toTwilio.push(JSON.parse(raw.toString())));

  return {
    fromModel,
    toTwilio,
    ended,
    openAIPort,
    send: (event) => twilio.send(JSON.stringify(event)),
    modelSays: (event) => modelSocket?.send(JSON.stringify(event)),
    async waitFor(predicate, what) {
      for (let i = 0; i < 200; i += 1) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Timed out waiting for ${what}`);
    },
    async close() {
      try { twilio.close(); } catch { /* already gone */ }
      await new Promise((r) => server.close(r));
      await new Promise((r) => fakeOpenAI.close(r));
    },
  };
}

test('nothing is sent to Twilio before the start event supplies a stream SID', async () => {
  const h = await callHarness();
  try {
    // A media frame arriving before `start` must not produce a reply that
    // Twilio would reject for having no streamSid.
    h.send({ event: 'media', media: { payload: 'AAAA' } });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(h.toTwilio, []);
  } finally {
    await h.close();
  }
});

test('a caller hanging up ends the call and records how long it ran', async () => {
  const h = await callHarness();
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ123', customParameters: { from: '+66812345678' } } });
    await new Promise((r) => setTimeout(r, 30));
    h.send({ event: 'stop' });
    await h.waitFor(() => h.ended.length > 0, 'the call to end');

    assert.equal(h.ended[0].reason, 'caller-hung-up');
    assert.equal(h.ended[0].from, '+66812345678');
    assert.ok(h.ended[0].seconds >= 0);
  } finally {
    await h.close();
  }
});

test('a call is only ended once, however many ways it closes', async () => {
  // stop, then close, then error — a hangup fires several of these and each
  // one would otherwise bill the same seconds again.
  const h = await callHarness();
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ1', customParameters: { from: '+1' } } });
    await new Promise((r) => setTimeout(r, 20));
    h.send({ event: 'stop' });
    h.send({ event: 'stop' });
    await h.waitFor(() => h.ended.length > 0, 'the call to end');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.ended.length, 1);
  } finally {
    await h.close();
  }
});

test('an unparseable frame from Twilio does not kill the call', async () => {
  const h = await callHarness();
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ1', customParameters: { from: '+1' } } });
    await new Promise((r) => setTimeout(r, 20));
    // Not JSON at all.
    h.send('not json');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.ended.length, 0, 'still up');
  } finally {
    await h.close();
  }
});

test('the upgrade handler ignores paths that are not the call stream', async () => {
  // A second WebSocket feature later must not have to fight this one.
  const server = http.createServer();
  attachCallStream(server, { askTheTeam: async () => '' });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;

  const stray = new WebSocket(`ws://127.0.0.1:${port}/something/else`);
  const [err] = await once(stray, 'error');
  assert.ok(err, 'refused rather than accepted onto the call bridge');
  await new Promise((r) => server.close(r));
});

// --- The three things that are audible if wrong -----------------------------------------

test('an interruption stops the model AND drops what Twilio has buffered', async () => {
  // Cancelling the model alone is not enough. Twilio keeps playing audio it
  // already holds, so the caller talks over a voice answering a question from
  // several seconds ago — the single most unnatural thing a voice agent does.
  const h = await callHarness();
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ9', customParameters: { from: '+66812345678' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');

    h.modelSays({ type: 'input_audio_buffer.speech_started' });

    await h.waitFor(() => h.fromModel.some((e) => e.type === 'response.cancel'), 'the model to be cut off');
    await h.waitFor(() => h.toTwilio.some((e) => e.event === 'clear'), "Twilio's buffer to be cleared");

    const cleared = h.toTwilio.find((e) => e.event === 'clear');
    assert.equal(cleared.streamSid, 'MZ9', 'cleared on the right stream');
  } finally {
    await h.close();
  }
});

test('audio from the model reaches Twilio tagged with the stream SID', async () => {
  const h = await callHarness();
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ7', customParameters: { from: '+1' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');

    // The GA event name. The beta one, response.audio.delta, is what the
    // model used to send; a fake still sending it would pass this test
    // while a real call played silence.
    h.modelSays({ type: 'response.output_audio.delta', delta: 'BASE64AUDIO' });
    await h.waitFor(() => h.toTwilio.some((e) => e.event === 'media'), 'audio to reach Twilio');

    const media = h.toTwilio.find((e) => e.event === 'media');
    assert.equal(media.streamSid, 'MZ7');
    assert.equal(media.media.payload, 'BASE64AUDIO', 'relayed untouched — no transcoding on the hot path');
  } finally {
    await h.close();
  }
});

test('the session is opened with Twilio\'s own audio format, both directions', async () => {
  // Any other format means transcoding, and transcoding means latency on the
  // one path where latency is the entire product.
  const h = await callHarness();
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ1', customParameters: { from: '+1' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');

    const update = h.fromModel.find((e) => e.type === 'session.update').session;
    assert.equal(update.type, 'realtime', 'GA sessions are typed; an untyped one is refused');
    assert.equal(update.audio.input.format.type, 'audio/pcmu');
    assert.equal(update.audio.output.format.type, 'audio/pcmu');
    assert.equal(update.audio.input.turn_detection.type, 'server_vad', 'a call has no push-to-talk button');
    assert.ok(update.tools.some((t) => t.name === 'ask_the_team'), 'and it can reach the company');
    // Nothing from the beta shape survives — any of these would be rejected
    // as an unknown parameter by the GA endpoint.
    for (const beta of ['modalities', 'voice', 'input_audio_format', 'output_audio_format', 'turn_detection', 'input_audio_transcription']) {
      assert.equal(update[beta], undefined, `beta field "${beta}" must not be sent`);
    }
  } finally {
    await h.close();
  }
});

test('the keypad choice becomes the language the call opens in', async () => {
  // The parameter the TwiML carried comes back on Twilio's start event; the
  // brief and the greeting are built from it, so the first words are in the
  // language the caller pressed for — not the configured default.
  const h = await callHarness();
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ9', customParameters: { from: '+1', language: 'Spanish' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');
    const update = h.fromModel.find((e) => e.type === 'session.update').session;
    assert.match(update.instructions, /Speak Spanish, whatever language/);
    const greeting = h.fromModel.find((e) => e.type === 'response.create');
    assert.match(greeting.response.instructions, /in Spanish/);
  } finally {
    await h.close();
  }
});

test('each model turn is timed to its first sound, and the call reports them', async () => {
  // "There is a lot of latency" needs a number. The greeting is measured from
  // the socket opening; a reply from the moment the model decided the caller
  // had stopped; a reply streamed in many deltas is measured once.
  const h = await callHarness();
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ_t', customParameters: { from: '+1' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');
    h.modelSays({ type: 'response.output_audio.delta', delta: 'A' });
    h.modelSays({ type: 'response.output_audio.delta', delta: 'B' });
    h.modelSays({ type: 'input_audio_buffer.speech_stopped' });
    await new Promise((r) => setTimeout(r, 30));
    h.modelSays({ type: 'response.output_audio.delta', delta: 'C' });
    h.modelSays({ type: 'response.output_audio.delta', delta: 'D' });
    await h.waitFor(() => h.toTwilio.filter((e) => e.event === 'media').length === 4, 'audio to flow');
    h.send({ event: 'stop' });
    await h.waitFor(() => h.ended.length === 1, 'the call to end');

    const { turns } = h.ended[0];
    assert.deepEqual(turns.map((t) => t.what), ['greeting', 'reply'], 'one measurement per turn, not per delta');
    assert.ok(turns[1].ms >= 25, `the reply wait is measured from speech_stopped, got ${turns[1].ms}ms`);
    assert.ok(turns.every((t) => Number.isInteger(t.ms) && t.ms >= 0));
  } finally {
    await h.close();
  }
});

test('the company answer arrives mid-call, in the voice, not after the call', async () => {
  // The whole design. The caller was told it was being asked; the answer has
  // to come back on the same call or the promise was empty.
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = await callHarness({ askTheTeam: () => slow });

  try {
    h.send({ event: 'start', start: { streamSid: 'MZ2', customParameters: { from: '+1' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');

    h.modelSays({
      type: 'response.done',
      response: {
        output: [{
          type: 'function_call',
          call_id: 'call_1',
          name: 'ask_the_team',
          arguments: JSON.stringify({ question: 'What is CircadianAPI priced at?', say_while_waiting: 'One moment.' }),
        }],
      },
    });

    // Acknowledged at once so the model is free to keep talking rather than
    // sitting on an open tool call for fifteen seconds.
    await h.waitFor(
      () => h.fromModel.some((e) => e.type === 'conversation.item.create' && e.item?.type === 'function_call_output'),
      'the tool call to be released immediately'
    );

    release('Twenty-nine dollars a month.');

    await h.waitFor(
      () => h.fromModel.some((e) => e.item?.role === 'system' && /Twenty-nine dollars/.test(e.item?.content?.[0]?.text || '')),
      'the answer to be delivered into the live call'
    );

    const delivered = h.fromModel.find((e) => /Twenty-nine dollars/.test(e.item?.content?.[0]?.text || ''));
    assert.match(delivered.item.content[0].text, /language of this call/, 'and spoken in the call\'s language');
  } finally {
    await h.close();
  }
});

test('a question that fails is said out loud, not swallowed', async () => {
  // The caller was told it was being asked. Silence afterwards is a broken
  // promise they have no way to detect.
  const h = await callHarness({ askTheTeam: async () => { throw new Error('the team is unreachable'); } });
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ3', customParameters: { from: '+1' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');

    h.modelSays({
      type: 'response.done',
      response: {
        output: [{
          type: 'function_call', call_id: 'c2', name: 'ask_the_team',
          arguments: JSON.stringify({ question: 'anything', say_while_waiting: 'sure' }),
        }],
      },
    });

    await h.waitFor(
      () => h.fromModel.some((e) => /the team is unreachable/.test(e.item?.content?.[0]?.text || '')),
      'the failure to be spoken'
    );
  } finally {
    await h.close();
  }
});

test('a tool call with no question does not reach the company', async () => {
  let asked = 0;
  const h = await callHarness({ askTheTeam: async () => { asked += 1; return 'x'; } });
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ4', customParameters: { from: '+1' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');

    h.modelSays({
      type: 'response.done',
      response: {
        output: [{ type: 'function_call', call_id: 'c3', name: 'ask_the_team', arguments: '{}' }],
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(asked, 0, 'an empty question is not a company turn');
  } finally {
    await h.close();
  }
});

test('the answer is dropped rather than delivered if the caller already hung up', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = await callHarness({ askTheTeam: () => slow });
  try {
    h.send({ event: 'start', start: { streamSid: 'MZ5', customParameters: { from: '+1' } } });
    await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');

    h.modelSays({
      type: 'response.done',
      response: {
        output: [{
          type: 'function_call', call_id: 'c4', name: 'ask_the_team',
          arguments: JSON.stringify({ question: 'q', say_while_waiting: 'ok' }),
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 40));

    h.send({ event: 'stop' });
    await h.waitFor(() => h.ended.length > 0, 'the call to end');

    const before = h.fromModel.length;
    release('an answer nobody is listening to');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(h.fromModel.length, before, 'nothing sent into a dead session');
  } finally {
    await h.close();
  }
});


// --- A stream has to prove it belongs to a call we answered --------------------------------
//
// The realtime session is the thing that costs money. With TWILIO_AUTH_TOKEN
// set, a stream that does not carry the token issued for its CallSid gets no
// session at all — the call is ended before the model is ever opened.

test('the TwiML carries a per-call token when the auth token is set', async () => {
  await withEnv({ VOICE_CALLS: 'true', CALL_ALLOWED_NUMBERS: '66812345678', TWILIO_AUTH_TOKEN: 'tok' }, async () => {
    const { streamToken } = await import('../realtime/twilioAuth.js');
    const xml = answerCallTwiml({ from: '+66812345678', host: 'h', callSid: 'CA123' });
    assert.match(xml, /name="callSid" value="CA123"/);
    assert.match(xml, new RegExp(`name="token" value="${streamToken('CA123')}"`));
  });
});

test('a stream without a valid token is ended before any model session opens', async () => {
  await withEnv({ TWILIO_AUTH_TOKEN: 'tok' }, async () => {
    const h = await callHarness();
    try {
      h.send({ event: 'start', start: { streamSid: 'MZ1', customParameters: { from: '+1', callSid: 'CA123', token: 'forged' } } });
      await h.waitFor(() => h.ended.length > 0, 'the stream to be refused');
      assert.equal(h.ended[0].reason, 'bad-stream-token');
      assert.deepEqual(h.fromModel, [], 'nothing was ever sent to the model');
    } finally {
      await h.close();
    }
  });
});

test('a stream carrying the token issued for its call proceeds to a session', async () => {
  await withEnv({ TWILIO_AUTH_TOKEN: 'tok' }, async () => {
    const { streamToken } = await import('../realtime/twilioAuth.js');
    const h = await callHarness();
    try {
      h.send({ event: 'start', start: { streamSid: 'MZ2', customParameters: { from: '+1', callSid: 'CA777', token: streamToken('CA777') } } });
      await h.waitFor(() => h.fromModel.some((e) => e.type === 'session.update'), 'the session to open');
      assert.equal(h.ended.length, 0, 'still up');
    } finally {
      await h.close();
    }
  });
});

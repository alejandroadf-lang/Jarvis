// A real-time conversation that needs no phone company.
//
// The Twilio bridge exists because WhatsApp calling is WebRTC over UDP and
// Railway does not accept inbound UDP, so somebody else has to terminate the
// media. For a prototype that is an account, a card, a number, per-minute
// telephony and a provider migration — to prove a conversation works.
//
// The browser removes all of it: the Realtime API speaks WebRTC straight to a
// page, so audio goes phone <-> OpenAI and Railway is not in the media path.
// What is left on the server is the one thing that must not happen in a
// browser, which is holding the key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintBrowserSession, isBrowserCallConfigured } from '../realtime/browserSession.js';

const KEYS = ['OPENAI_API_KEY', 'OPENAI_REALTIME_MODEL', 'OPENAI_REALTIME_VOICE', 'REPLY_LANGUAGE'];

async function withEnv(values, run) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const savedFetch = global.fetch;
  Object.assign(process.env, values);
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k];
  try {
    return await run();
  } finally {
    global.fetch = savedFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function captureSession(response = {}) {
  const sent = {};
  global.fetch = async (url, options) => {
    sent.url = String(url);
    sent.auth = options?.headers?.Authorization;
    sent.body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        client_secret: { value: 'ek_abc123', expires_at: 1790000000 },
        ...response,
      }),
    };
  };
  return sent;
}

test('with no key there is nothing to talk to, and it says so rather than throwing later', async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    assert.equal(isBrowserCallConfigured(), false);
    await assert.rejects(() => mintBrowserSession(), /OPENAI_API_KEY is not set/);
  });
});

test('the page gets a short-lived token, never the API key', async () => {
  // The whole reason this endpoint exists. Anyone who opens devtools on the
  // page would otherwise own the OpenAI account.
  await withEnv({ OPENAI_API_KEY: 'sk-real-key-do-not-leak' }, async () => {
    const sent = captureSession();
    const session = await mintBrowserSession();

    assert.equal(session.token, 'ek_abc123');
    assert.equal(sent.auth, 'Bearer sk-real-key-do-not-leak', 'the real key is used server-side');
    assert.doesNotMatch(JSON.stringify(session), /sk-real-key/, 'and never reaches the page');
  });
});

test('the brief, the tools and the turn detection are fixed by the server', async () => {
  // A browser can be edited by whoever holds the phone. Anything the page
  // could choose is something an attacker could choose — so the instruction
  // that says "do not promise anything to anyone outside the company" has to
  // be decided here or it is decorative.
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    const sent = captureSession();
    await mintBrowserSession();

    assert.match(sent.body.instructions, /COMPANY STATE/, 'the company brief');
    assert.match(sent.body.instructions, /never tell them|Do not say you cannot hear/i);
    assert.match(sent.body.instructions, /Do not agree to send anything, pay anything, or promise anything/);
    assert.equal(sent.body.turn_detection.type, 'server_vad', 'a conversation has no push-to-talk');
    assert.ok(sent.body.tools.some((t) => t.name === 'ask_the_team'), 'and it can reach the real company');
  });
});

test('audio format is left to the API rather than forced to the phone codec', async () => {
  // g711_ulaw was Twilio's constraint. A browser gets full-band Opus, which is
  // the better-sounding half of this whole feature — pinning the phone format
  // here would throw that away for no reason.
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    const sent = captureSession();
    await mintBrowserSession();
    assert.equal(sent.body.input_audio_format, undefined);
    assert.equal(sent.body.output_audio_format, undefined);
  });
});

test('a pinned reply language reaches the conversation brief', async () => {
  // The translation case: brief it in one language, hear the answer in
  // another. It has to be in the instructions, because on this path there is
  // no transcription step downstream to attach it to.
  await withEnv({ OPENAI_API_KEY: 'k', REPLY_LANGUAGE: 'es' }, async () => {
    const sent = captureSession();
    await mintBrowserSession();
    assert.match(sent.body.instructions, /Speak Spanish, whatever language/);
  });
});

test('with no pin it mirrors the speaker and follows a switch mid-conversation', async () => {
  // The advantage this path has over voice notes: one model hears and answers,
  // so there is no language code converted into a string for something else to
  // look up — which is the exact shape of the bug that answered Spanish in
  // English for months.
  await withEnv({ OPENAI_API_KEY: 'k', REPLY_LANGUAGE: undefined }, async () => {
    const sent = captureSession();
    await mintBrowserSession();
    assert.match(sent.body.instructions, /Speak whatever language .* speaks, and switch when they switch/);
  });
});

test('a session with no client secret fails loudly rather than handing the page nothing', async () => {
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await assert.rejects(() => mintBrowserSession(), /no client secret/);
  });
});

test('an OpenAI refusal carries its status and reason', async () => {
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    await assert.rejects(
      () => mintBrowserSession(),
      (err) => err.status === 429 && /rate limited/.test(err.message)
    );
  });
});

test('the model the page is told to use is the model the session was minted for', async () => {
  // The page builds its WebRTC URL from this. A mismatch is a connection that
  // fails at the SDP exchange with nothing explaining why.
  await withEnv({ OPENAI_API_KEY: 'k', OPENAI_REALTIME_MODEL: 'gpt-realtime-test' }, async () => {
    const sent = captureSession();
    const session = await mintBrowserSession();
    assert.equal(sent.body.model, 'gpt-realtime-test');
    assert.equal(session.model, 'gpt-realtime-test');
  });
});

// --- The desk session, which must not be the founder's session ---------------------------

test('a desk session carries no company state and no tools', async () => {
  // Two failures guarded at once. The founder's brief holds revenue and the
  // pipeline; ask_the_team runs a real company turn whose answer is written
  // for the founder — and is also how a stranger could make this company do
  // work by asking it to.
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    const { createVenture, setPricing } = await import('../finance/ventures.js');
    const v = createVenture({ title: 'DeskTest', oneLiner: 'A thing.', targetCustomer: 'People' });
    setPricing(v.id, { currency: 'USD', floorMonthly: 29, perUnit: 0, unit: '' });

    const sent = captureSession();
    const session = await mintBrowserSession({ desk: v.id });

    assert.doesNotMatch(sent.body.instructions, /COMPANY STATE/, 'no company state');
    assert.deepEqual(sent.body.tools, [], 'no tools');
    assert.equal(sent.body.tool_choice, 'none');
    assert.match(sent.body.instructions, /DeskTest/);
    assert.equal(session.desk, 'DeskTest', 'the page is told which desk it reached');
  });
});

test('the founder session still gets both, so the branch did not break it', async () => {
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    const sent = captureSession();
    await mintBrowserSession();
    assert.match(sent.body.instructions, /COMPANY STATE/);
    assert.ok(sent.body.tools.some((t) => t.name === 'ask_the_team'));
  });
});

test('a desk for a venture that does not exist is refused, not answered emptily', async () => {
  // Answering as a desk with no product is worse than not answering: the
  // caller reaches something that sounds official and knows nothing.
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    captureSession();
    await assert.rejects(() => mintBrowserSession({ desk: 'v_nope' }), /no venture "v_nope"/);
  });
});

// --- The support desk session --------------------------------------------------------------

test('a support session gets the desk tools, the support brief, and no company state', async () => {
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    const sent = captureSession();
    const session = await mintBrowserSession({ support: true });
    assert.deepEqual(sent.body.tools.map((t) => t.name).sort(), ['lookup_issue', 'open_ticket']);
    assert.equal(sent.body.tool_choice, 'auto', 'it must be able to look things up');
    // The default persona is the agency's own desk; the shared body marks any
    // support brief regardless of persona.
    assert.match(sent.body.instructions, /travel help desk/);
    assert.match(sent.body.instructions, /HOW A SUPPORT CALL GOES/);
    assert.doesNotMatch(sent.body.instructions, /COMPANY STATE/);
    assert.ok(!sent.body.tools.some((t) => t.name === 'ask_the_team'), 'a caller cannot make the company do work');
    assert.equal(session.support, true);
    assert.match(session.desk, /help desk|support desk/, 'named for whichever persona is the default');
  });
});

test('support wins over a venture desk if both are sent, since the support brief is the safer one', async () => {
  await withEnv({ OPENAI_API_KEY: 'k' }, async () => {
    const sent = captureSession();
    await mintBrowserSession({ support: true, desk: 'v_does_not_exist' });
    assert.match(sent.body.instructions, /HOW A SUPPORT CALL GOES/, 'and the unknown venture is never looked up');
  });
});

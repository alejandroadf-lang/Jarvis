// One pitch a morning, and the reason it does not become noise by week three.
//
// Idea homogenisation in LLMs is collective rather than individual — each
// person gets more ideas and everyone gets the same ones — and the effect
// survives prompt and temperature modification. "Be more original" does not
// fix it. Inside one context, early outputs constrain later ones, so a
// generator with no memory circles the same attractor forever.
//
// That makes the de-duplication the load-bearing part of this feature, not a
// nicety, and most of these tests are about it. The rest protect the two
// properties that keep a daily idea generator honest: it cannot start
// anything, and it has to carry its own counter-case.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let pitch;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pitch-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  pitch = await import('../pitchOfTheDay.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'pitches.json'), { force: true });
});

function fullPitch(overrides = {}) {
  return {
    title: 'SleepSync',
    oneLiner: 'circadian scheduling for distributed engineering teams',
    hook: 'Your on-call rota is costing you a senior engineer a year.',
    problem: 'Rotas ignore chronotype.',
    why_now: 'Wearable sleep data became an API in 2025.',
    agent_native_edge: 'Per-team bespoke rota modelling at a price nobody can staff.',
    path_to_a_million: '350 teams at €250/month.',
    what_would_have_to_be_true: 'Engineering managers must believe rota quality is theirs to fix.',
    how_to_kill_it_this_week: 'Ten manager interviews; fail if fewer than three name rotas unprompted.',
    ...overrides,
  };
}

// A runAgent stand-in that pitches whatever it is told to.
function generatorOf(...sequence) {
  let call = 0;
  const fake = async ({ actionHandlers }) => {
    const next = sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    if (next) actionHandlers.present_pitch(next);
    return { text: '', trace: [] };
  };
  fake.calls = () => call;
  return fake;
}

// --- Catching the repeat ----------------------------------------------------------------

// The failure that actually happens is not a subtle paraphrase. It is the same
// idea with the nouns swapped.
test('the same idea renamed reads as a repeat', () => {
  const score = pitch.similarity(
    'SleepSync circadian scheduling for distributed engineering teams',
    'RestAlign circadian scheduling for remote engineering teams'
  );
  assert.ok(score >= 0.45, `expected a repeat, scored ${score}`);
});

test('a genuinely different idea does not', () => {
  const score = pitch.similarity(
    'SleepSync circadian scheduling for distributed engineering teams',
    'LedgerLens reconciliation for freight invoices'
  );
  assert.ok(score < 0.2, `expected difference, scored ${score}`);
});

// Generic startup vocabulary is in every pitch ever written, so counting it
// would make every idea look like every other one.
test('filler words do not manufacture similarity', () => {
  const score = pitch.similarity(
    'an AI agent platform for the customer service market',
    'an AI agent platform for the logistics market'
  );
  assert.ok(score < 0.45, `generic words alone should not read as a repeat, scored ${score}`);
});

test('a repeat is caught against what has already been pitched', () => {
  pitch.savePitch(fullPitch());
  assert.equal(pitch.isRepeat({ title: 'RestAlign', oneLiner: 'circadian scheduling for remote engineering teams' }), true);
  assert.equal(pitch.isRepeat({ title: 'LedgerLens', oneLiner: 'reconciliation for freight invoices' }), false);
});

// Naming the match is what makes the re-ask usable: "you already pitched this
// on the 14th" is an instruction, "too similar" is not.
test('the closest previous pitch is named, not just scored', () => {
  pitch.savePitch(fullPitch());
  const closest = pitch.closestPrevious({ title: 'RestAlign', oneLiner: 'circadian scheduling for remote engineering teams' });
  assert.equal(closest.pitch.title, 'SleepSync');
  assert.ok(closest.score > 0);
});

test('with no history nothing is a repeat', () => {
  assert.equal(pitch.isRepeat(fullPitch()), false);
  assert.match(pitch.describePreviousPitches(), /Nothing has been pitched yet/);
});

// --- The generator loop -------------------------------------------------------------------

test('a fresh idea is saved and returned first time', async () => {
  const runAgent = generatorOf(fullPitch());
  const result = await pitch.generatePitch({ anthropic: {}, runAgent, agents: {}, agentId: 'venture_partner' });
  assert.equal(result.pitch.title, 'SleepSync');
  assert.equal(result.attempts, 1);
  assert.equal(pitch.listPitches().length, 1);
});

test('a repeat is re-asked once, and a different idea is accepted', async () => {
  pitch.savePitch(fullPitch());
  const runAgent = generatorOf(
    fullPitch({ title: 'RestAlign' }),
    fullPitch({ title: 'LedgerLens', oneLiner: 'reconciliation for freight invoices' })
  );
  const result = await pitch.generatePitch({ anthropic: {}, runAgent, agents: {}, agentId: 'venture_partner' });
  assert.equal(result.pitch.title, 'LedgerLens');
  assert.equal(result.attempts, 2);
});

// A founder who reads the same idea twice stops reading. Sending the repeat
// anyway would be the easy behaviour and the wrong one.
test('two repeats produce no pitch and an honest explanation', async () => {
  pitch.savePitch(fullPitch());
  const runAgent = generatorOf(fullPitch({ title: 'RestAlign' }));
  const result = await pitch.generatePitch({ anthropic: {}, runAgent, agents: {}, agentId: 'venture_partner' });

  assert.equal(result.pitch, null);
  assert.match(result.note, /No pitch today/);
  assert.match(result.note, /SleepSync/, 'and names what it kept circling');
  assert.match(result.note, /a steer from you/, 'and what would break it out');
  assert.equal(pitch.listPitches().length, 1, 'the repeat is not saved');
});

test('the retry tells the generator what it repeated', async () => {
  pitch.savePitch(fullPitch());
  const prompts = [];
  const runAgent = async ({ messages, actionHandlers }) => {
    prompts.push(messages[0].content);
    actionHandlers.present_pitch(fullPitch({ title: 'RestAlign' }));
    return { text: '', trace: [] };
  };
  await pitch.generatePitch({ anthropic: {}, runAgent, agents: {}, agentId: 'venture_partner' });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /too close to "SleepSync"/);
  assert.match(prompts[1], /not the same idea renamed/);
});

test('a generator that returns nothing does not crash the morning', async () => {
  const runAgent = generatorOf(null);
  const result = await pitch.generatePitch({ anthropic: {}, runAgent, agents: {}, agentId: 'venture_partner' });
  assert.equal(result.pitch, null);
  assert.match(result.note, /nothing usable/);
});

// --- What keeps it honest --------------------------------------------------------------------

// A daily "revolutionary idea" generator is a hype machine by default. The
// slides that make it worth reading on day thirty are the uncomfortable ones.
test('the pitch shape forces a counter-case', () => {
  const required = pitch.PITCH_TOOL.input_schema.required;
  assert.ok(required.includes('what_would_have_to_be_true'));
  assert.ok(required.includes('how_to_kill_it_this_week'));
  assert.ok(required.includes('why_now'));
});

test('the path to a million must be arithmetic, not a TAM', () => {
  const description = pitch.PITCH_TOOL.input_schema.properties.path_to_a_million.description;
  assert.match(description, /Not a TAM/i);
});

// It is a provocation, not a proposal — there is no propose_venture in its
// handler map, and the email says so out loud.
test('the email says plainly that nothing has been started', () => {
  const { subject, text } = pitch.formatPitchEmail(fullPitch());
  assert.match(subject, /Pitch of the day: SleepSync/);
  // The wording changed once: "no venture exists" read as a claim about the
  // portfolio when a priced venture was in it. The property this pins is that
  // the email disclaims starting anything, not the sentence it uses to do so.
  assert.match(text, /a pitch never creates a venture/);
  assert.match(text, /provocation, not a proposal/);
});

test('every slide reaches the email', () => {
  const { text } = pitch.formatPitchEmail(fullPitch());
  for (const fragment of [
    'costing you a senior engineer',
    'Rotas ignore chronotype',
    'Wearable sleep data',
    '350 teams at €250/month',
    'rota quality is theirs to fix',
    'fewer than three name rotas',
  ]) {
    assert.match(text, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('a no-pitch morning still sends the reason', () => {
  const { text } = pitch.formatPitchEmail({}, { note: 'No pitch today. Both attempts repeated SleepSync.' });
  assert.match(text, /Both attempts repeated SleepSync/);
});

// --- Memory ----------------------------------------------------------------------------------

test('past pitches are described for the prompt, newest last', () => {
  pitch.savePitch(fullPitch({ title: 'First' }));
  pitch.savePitch(fullPitch({ title: 'Second', oneLiner: 'freight invoice reconciliation' }));
  const text = pitch.describePreviousPitches();
  assert.match(text, /do not pitch these again/);
  assert.ok(text.indexOf('First') < text.indexOf('Second'));
});

test('the history is bounded so the prompt cannot grow forever', () => {
  for (let i = 0; i < 80; i += 1) pitch.savePitch(fullPitch({ title: `Idea${i}`, oneLiner: `thing number ${i}` }));
  assert.ok(pitch.listPitches().length <= 60);
});

// --- The morning that was empty for weeks -----------------------------------------------
//
// present_pitch was passed as a handler and never as a tool. runAgent offers
// the model only what is in agent.actions, so the prompt said "call
// present_pitch" to a model with no such tool. captured stayed null, both
// attempts, every morning. The tests above never saw it: generatorOf calls the
// handler directly and never goes through tool assembly — the fake agreed with
// the author and the runner did not. These check what runAgent is actually
// handed.

test('the model is offered present_pitch, and only present_pitch', async () => {
  let handed = null;
  const runAgent = async ({ agents, agentId, actionHandlers }) => {
    handed = agents[agentId];
    // Behave like the real runner: only a tool in actions is callable.
    if ((handed?.actions || []).some((a) => a.name === 'present_pitch')) actionHandlers.present_pitch(fullPitch());
    return { text: '', trace: [] };
  };

  const result = await pitch.generatePitch({
    anthropic: {},
    runAgent,
    agents: { venture_partner: { id: 'venture_partner', actions: [{ name: 'propose_venture' }], reports: ['x'] } },
    agentId: 'venture_partner',
  });

  assert.ok(handed, 'the runner was given the root agent');
  assert.deepEqual(handed.actions.map((a) => a.name), ['present_pitch'], 'exactly one tool');
  assert.deepEqual(handed.reports, [], 'and nobody to delegate to');
  assert.equal(result.pitch?.title, 'SleepSync', 'so a pitch actually lands');
});

test('propose_venture is not offered, so the promise that a pitch starts nothing holds at the tool list', async () => {
  let handed = null;
  const runAgent = async ({ agents, agentId }) => {
    handed = agents[agentId];
    return { text: '', trace: [] };
  };
  await pitch.generatePitch({
    anthropic: {},
    runAgent,
    agents: { venture_partner: { actions: [{ name: 'propose_venture' }] } },
    agentId: 'venture_partner',
  });
  assert.ok(!handed.actions.some((a) => a.name === 'propose_venture'));
});

// --- Linked to what is being built --------------------------------------------------------

test('the kickoff tells the generator what the company is building, with buyer and price', async () => {
  const ventures = await import('../finance/ventures.js');
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
  const v = ventures.createVenture({
    title: 'CircadianAPI',
    oneLiner: 'Sleep-cycle scoring for wearables.',
    targetCustomer: 'Wearable hardware companies with an existing app.',
  });
  ventures.setPricing(v.id, { currency: 'USD', floorMonthly: 29, perUnit: 0, unit: '' });

  let prompt = '';
  const runAgent = async ({ messages, actionHandlers }) => {
    prompt = messages[0].content;
    actionHandlers.present_pitch(fullPitch());
    return { text: '', trace: [] };
  };
  await pitch.generatePitch({ anthropic: {}, runAgent, agents: {}, agentId: 'venture_partner' });

  assert.match(prompt, /What the company is building now/);
  assert.match(prompt, /CircadianAPI — Sleep-cycle scoring for wearables/);
  assert.match(prompt, /buyer: Wearable hardware companies/);
  assert.match(prompt, /USD 29\.00\/month/);
  assert.match(prompt, /no customers yet/);
  assert.match(prompt, /compounds with what is being built/, 'and is asked to build next to it');
  assert.match(prompt, /Do not re-pitch a live venture under a new name/, 'without simply re-pitching it');
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
});

test('with no live venture the kickoff says so rather than inventing a portfolio', async () => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
  let prompt = '';
  const runAgent = async ({ messages, actionHandlers }) => {
    prompt = messages[0].content;
    actionHandlers.present_pitch(fullPitch());
    return { text: '', trace: [] };
  };
  await pitch.generatePitch({ anthropic: {}, runAgent, agents: {}, agentId: 'venture_partner' });
  assert.match(prompt, /no live venture yet/);
  assert.doesNotMatch(prompt, /What the company is building now/);
});

test('the no-pitch email no longer claims that no venture exists', () => {
  // The founder read "Nothing has been started and no venture exists" with a
  // priced venture in the portfolio, and reasonably asked whether the
  // generator could see it. The disclaimer meant "a pitch starts nothing" and
  // said something else.
  const { text } = pitch.formatPitchEmail({}, { note: 'No pitch today.' });
  assert.doesNotMatch(text, /no venture exists/i);
  assert.match(text, /a pitch never creates a venture/);
  const deck = pitch.formatPitchEmail(fullPitch()).text;
  assert.doesNotMatch(deck, /no venture exists/i);
});

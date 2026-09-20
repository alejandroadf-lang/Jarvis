// One pitch a morning.
//
// The founder asked for an elevator pitch every day at 8am — a revolutionary
// idea, argued as if to an investor. The obvious build is a prompt and a cron.
// That build fails in about three weeks, for a reason worth writing down.
//
// Idea homogenisation in LLMs is **collective, not individual**: each person
// gets more ideas, and everyone gets the *same* ideas. Worse, the effect
// survives prompt and temperature modification — "be more original" does not
// fix it. And inside a single context, early outputs constrain later ones, so a
// generator that never sees what it said before will circle the same attractor
// forever. Pioneer Square Labs generated 160,000 candidate ideas, culled them
// to 10,000, and needed automated near-duplicate detection as core pipeline
// infrastructure to do it — a 16:1 cull for similarity alone.
//
// So the defence here is structural rather than instructional. Past pitches go
// into the prompt *and* every new pitch is checked against them by token
// overlap before it is sent. A repeat is rejected and re-asked; a second repeat
// is reported honestly rather than dressed up, because a founder who reads the
// same idea twice stops reading.
//
// Two deliberate limits on what this is:
//
//   1. It is not a venture proposal. No propose_venture tool is wired in, so a
//      daily idea generator cannot quietly fill the portfolio. If the founder
//      wants one built, they say so and the Studio proposes it properly.
//   2. Every pitch must carry its own counter-case. A daily "revolutionary
//      idea" generator is a hype machine by default, and this codebase already
//      has claimCheck.js because claims outran reality once. The slides that
//      make it useful on day thirty are the uncomfortable ones.

import { readJson, writeJson } from './store.js';

const FILE = 'pitches.json';
const KEPT = 60;

// How much overlap counts as "we already pitched this". Tuned deliberately
// loose: the cost of a false positive is one re-ask, and the cost of a false
// negative is the founder reading the same idea twice and losing the habit.
const SIMILARITY_LIMIT = 0.45;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'their', 'have', 'your', 'you', 'not', 'are',
  'platform', 'service', 'tool', 'system', 'solution', 'api', 'app', 'agent', 'agents', 'ai',
  'business', 'company', 'market', 'customer', 'customers', 'using', 'based', 'powered', 'driven',
]);

export function fingerprint(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word))
  );
}

/**
 * Jaccard overlap of the distinctive words in two pitches.
 *
 * Crude on purpose. Embeddings would be better and would cost a call per
 * comparison per day forever; this catches the failure that actually happens,
 * which is not a subtle paraphrase but the same idea with the nouns swapped.
 */
export function similarity(a, b) {
  const first = fingerprint(a);
  const second = fingerprint(b);
  if (!first.size || !second.size) return 0;
  let shared = 0;
  for (const word of first) if (second.has(word)) shared += 1;
  return shared / (first.size + second.size - shared);
}

function load() {
  return readJson(FILE, { pitches: [] });
}

export function listPitches() {
  return load().pitches;
}

/**
 * The closest thing already pitched, and how close.
 *
 * Returns the match rather than a boolean so the re-ask can name it: "you
 * already pitched this on the 14th" is a usable instruction, "too similar" is
 * not.
 */
export function closestPrevious(pitch) {
  const text = `${pitch?.title || ''} ${pitch?.oneLiner || ''}`;
  let best = null;
  for (const previous of listPitches()) {
    const score = similarity(text, `${previous.title} ${previous.oneLiner}`);
    if (!best || score > best.score) best = { pitch: previous, score };
  }
  return best;
}

export function isRepeat(pitch) {
  const closest = closestPrevious(pitch);
  return Boolean(closest && closest.score >= SIMILARITY_LIMIT);
}

export function savePitch(pitch) {
  const data = load();
  const entry = { ...pitch, at: new Date().toISOString() };
  data.pitches.push(entry);
  if (data.pitches.length > KEPT) data.pitches = data.pitches.slice(-KEPT);
  writeJson(FILE, data);
  return entry;
}

/**
 * What the generator is told it has already said.
 *
 * In the prompt as well as in the check, even though the evidence says prompt
 * interventions do not fix homogenisation on their own. They are not useless —
 * they just are not sufficient — and a generator with no memory at all is
 * guaranteed to repeat rather than merely likely to.
 */
export function describePreviousPitches(limit = 20) {
  const recent = listPitches().slice(-limit);
  if (!recent.length) return 'Nothing has been pitched yet.';
  return [
    'Already pitched — do not pitch these again, or a variation with the nouns swapped:',
    ...recent.map((p) => `  ${p.at.slice(0, 10)}: ${p.title} — ${p.oneLiner}`),
  ].join('\n');
}

/**
 * The slides, as a tool schema.
 *
 * Structured rather than prose so the email renders the same every morning,
 * and because the shape is the argument: the fields below are what an elevator
 * pitch has to answer, and a model that cannot fill one of them has found a
 * hole in its own idea rather than a formatting problem.
 */
export const PITCH_TOOL = {
  name: 'present_pitch',
  description:
    "Present today's idea as an elevator pitch. One idea, argued properly. This does not start a venture and commits the company to nothing — it is a provocation for the founder over coffee, so aim high and be specific rather than safe and vague.",
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What it is called. A name, not a description.' },
      oneLiner: { type: 'string', description: 'One sentence: what it is and who it is for.' },
      hook: {
        type: 'string',
        description: 'The opening line you would actually say. The thing that makes someone look up — a number, a contradiction, a specific moment of pain.',
      },
      problem: { type: 'string', description: 'Whose problem, how they solve it today, and why that is bad.' },
      why_now: {
        type: 'string',
        description: 'What changed recently that makes this possible or necessary now and not three years ago. If nothing changed, say so — that is a real answer and usually a fatal one.',
      },
      agent_native_edge: {
        type: 'string',
        description: "Why an agent-run company wins at this specifically, and not just 'it is cheaper for us'. A funded team can absorb cheaper.",
      },
      path_to_a_million: {
        type: 'string',
        description: 'The arithmetic, written out: how many customers at what price. Not a TAM. 100 at €10k, or 1,000 at €1k.',
      },
      what_would_have_to_be_true: {
        type: 'string',
        description: 'The assumption the whole thing rests on — the one that, if false, kills it. Name the single riskiest one, not a list of three comfortable ones.',
      },
      how_to_kill_it_this_week: {
        type: 'string',
        description: 'The cheapest test that would prove it wrong within a week, and what result would count as failure. Be specific enough that someone could run it tomorrow.',
      },
    },
    required: [
      'title',
      'oneLiner',
      'hook',
      'problem',
      'why_now',
      'agent_native_edge',
      'path_to_a_million',
      'what_would_have_to_be_true',
      'how_to_kill_it_this_week',
    ],
  },
};

/** The deck, as an email. Slides, because that is how it reads at 8am. */
export function formatPitchEmail(pitch, { note = '' } = {}) {
  // A morning with no pitch still gets an email, because silence would read as
  // the scheduler having died. It carries the reason and nothing else.
  if (!pitch || !pitch.title) {
    return {
      subject: 'Pitch of the day: nothing new',
      text: [note || 'No pitch this morning.', '', 'Nothing has been started and no venture exists.'].join('\n'),
    };
  }

  const slide = (n, heading, body) => [`── ${n} · ${heading.toUpperCase()} ──`, '', body, ''].join('\n');
  // Built with nulls for "omit" rather than empty strings, because a blank
  // line is content here and filtering on '' ate the one under the title.
  const text = [
    pitch.title.toUpperCase(),
    pitch.oneLiner,
    '',
    note ? `${note}\n` : null,
    slide(1, 'The hook', pitch.hook),
    slide(2, 'The problem', pitch.problem),
    slide(3, 'Why now', pitch.why_now),
    slide(4, 'Why us', pitch.agent_native_edge),
    slide(5, 'The path to €1M', pitch.path_to_a_million),
    slide(6, 'What would have to be true', pitch.what_would_have_to_be_true),
    slide(7, 'How to kill it this week', pitch.how_to_kill_it_this_week),
    '───',
    'This is a provocation, not a proposal. Nothing has been started and no venture exists.',
    'If you want it built, say so and the Studio will work it up properly.',
  ]
    .filter((part) => part !== null)
    .join('\n');

  return { subject: `Pitch of the day: ${pitch.title}`, text };
}

// --- Running it -------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

function kickoff(previous) {
  return `Pitch one idea this morning, as an elevator pitch to an investor who has four minutes.

One idea, not three. Argue it properly and aim high: something that could be a
€1M+ business an agent-run company is structurally better placed to build than a
funded, conventionally-staffed competitor. Be specific and be willing to be
wrong — a sharp idea that might fail is worth more over coffee than a safe one
nobody would act on.

Two slides decide whether this is worth reading on day thirty rather than day
one. "What would have to be true" names the single assumption that kills it if
false — the riskiest one, not three comfortable ones. "How to kill it this week"
is a real test someone could run tomorrow, with the result that would count as
failure. A pitch that cannot fill those honestly has found a hole in itself.

This starts nothing. There is no venture, no commitment and no work — so do not
hedge toward something safe on the grounds that it might get built.

${previous}

Call present_pitch once. No preamble.`;
}

/**
 * Today's pitch, or an honest account of why there isn't one.
 *
 * @returns {Promise<{pitch: object|null, note: string, attempts: number}>}
 */
export async function generatePitch({ anthropic, runAgent, agents, agentId }) {
  let lastRepeat = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let captured = null;
    // Only a *repeat* gets the corrective steer. An attempt that produced
    // nothing at all has nothing to be steered away from, and reaching into
    // lastRepeat there was a crash on the one path nobody watches.
    const previous = lastRepeat
      ? `${describePreviousPitches()}\n\nYour last attempt ("${lastRepeat.candidate.title}") was too close to "${lastRepeat.match.pitch.title}" from ${lastRepeat.match.pitch.at.slice(0, 10)}. Pitch something genuinely different — a different buyer, a different problem, not the same idea renamed.`
      : describePreviousPitches();

    await runAgent({
      anthropic,
      agents,
      agentId,
      messages: [{ role: 'user', content: kickoff(previous) }],
      actionHandlers: {
        present_pitch: (input) => {
          captured = input;
          return 'Noted.';
        },
      },
    });

    if (!captured) continue;
    const match = closestPrevious(captured);
    if (match && match.score >= SIMILARITY_LIMIT) {
      lastRepeat = { candidate: captured, match };
      continue;
    }
    return { pitch: savePitch(captured), note: '', attempts: attempt };
  }

  // Said plainly rather than sending the repeat anyway. A founder who reads the
  // same idea twice stops reading, and the honest version at least reports a
  // real property of the generator.
  if (lastRepeat) {
    return {
      pitch: null,
      note: `No pitch today. Both attempts came back close to "${lastRepeat.match.pitch.title}" (${lastRepeat.match.at || lastRepeat.match.pitch.at.slice(0, 10)}), so nothing new was actually generated. That is worth knowing: it usually means the recent pitches have boxed the generator in, and a steer from you would break it out.`,
      attempts: MAX_ATTEMPTS,
    };
  }
  return { pitch: null, note: 'No pitch today — the generator returned nothing usable.', attempts: MAX_ATTEMPTS };
}

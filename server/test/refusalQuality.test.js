// Every refusal must name a way forward.
//
// This is the generalisation of the bug that cost the team a week. The
// deployment cap refused with "Weekly deployment cap reached (3/week)" — a
// number and nothing else. An agent that hits a wall with no door reads it as
// a fault in itself, and tries again; five turns went that way, and one of
// them ended in a claim of work that had not happened.
//
// The same shape has now appeared five times in this codebase under different
// names, always as "a capability behind a door nobody could open". Fixing the
// sixth instance is not the answer. This test is: a refusal thrown by the gate
// layer must tell whoever reads it what would change the answer.
//
// Four things count as a way forward, and one of them is honesty about there
// being none:
//
//   1. Something the founder does — a named WhatsApp command, or "the founder
//      needs to...". The agent can then ask for exactly that.
//   2. Something the agent does — "call run_checks", "submit a plan".
//   3. Nothing, said out loud — "nothing will change this", "this waits for
//      tomorrow". A closed door is fine; a closed door with no sign is not.
//   4. A description of malformed input. "ventureId is required" already tells
//      the caller what to fix, and dressing it up would be noise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The modules that stand between an agent and a real-world act. A refusal from
// any of these is read by an agent mid-turn with no other source of truth.
const GATE_FILES = [
  'finance/ventures.js',
  'killSwitch.js',
  'dailyPlan.js',
  'spend.js',
  'execute/probe.js',
];

// 1. The founder can open it — by command, by setting, or by being asked.
const FOUNDER_REMEDY = /founder|\b(?:CAPS|DEPLOY ON|DEPLOY OFF|OUTREACH|RESUME|HALT|CONSENT|UNBLOCK|LINK|PRICE|BOOKING|URL|PLAN)\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b|\b(?:raise|unset|set) /i;
// 2. The agent can open it.
const AGENT_REMEDY = /\bcall \w+|run_checks|check_ready|submit_daily_plan|check_daily_plan|log_\w+|deploy_changes|\buse the \w+/i;
// 3. It cannot be opened, and says so.
const FINALITY = /nothing will change|will not change it|is final|waits? for|wait it out|clears on its own|cannot be undone|there is no|already |not this app|did not make that change/i;
// 4. The caller passed something wrong and is told what.
const VALIDATION = /required|missing|needs? (?:at least|to|a |an |something)|must (?:be|start|end|contain|match|fall)|at least one|appears twice|no files|invalid|positive number|cannot be read|check the id|valid \w+ (?:are|is)/i;

/**
 * Pulls the source text of every `throw new Error(...)` out of a file.
 *
 * Deliberately reads the raw expression rather than the evaluated string:
 * the question is whether the wording offers a remedy, and a template
 * placeholder does not change that.
 */
function refusals(source) {
  return [...extract(source, 'throw new Error('), ...extract(source, 'fail(')]
    // `throw new Error(message)` where the argument is only a name — a bare
    // identifier, or a property read off one — is a re-throw of text written
    // somewhere else. probe.js builds its messages through a fail() helper;
    // authorizeOutreach re-throws the first shut gate's `reason`. Both are
    // judged where the wording actually lives, which for the gates is a few
    // lines above in the same file, so nothing escapes by taking this route.
    .filter(({ text }) => !/^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*$/.test(text));
}

function extract(source, marker) {
  const out = [];
  let i = source.indexOf(marker);
  while (i !== -1) {
    let depth = 0;
    let j = i + marker.length - 1;
    for (; j < source.length; j += 1) {
      if (source[j] === '(') depth += 1;
      else if (source[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const text = source.slice(i + marker.length, j);
    const line = source.slice(0, i).split('\n').length;
    out.push({ text, line });
    i = source.indexOf(marker, j);
  }
  return out;
}

test('the extractor finds whole multi-line refusals, not fragments', () => {
  // Guarding the guard: a broken extractor would silently find nothing and
  // this file would pass forever while proving nothing.
  const found = refusals(`
    throw new Error('one');
    throw new Error(
      \`two (\${x}) with parens\` + ' and more'
    );
  `);
  assert.equal(found.length, 2);
  assert.match(found[1].text, /two/);
  assert.match(found[1].text, /and more/, 'the whole expression, not the first line');
});

test('a pass-through re-throw is skipped, but a real message never is', () => {
  // The exemption above is narrow on purpose. It must cover a name being
  // re-thrown and nothing else — an exemption that swallowed a literal would
  // quietly turn this whole file off.
  const found = refusals(`
    throw new Error(message);
    throw new Error(shut.reason);
    throw new Error(\`Weekly cap reached (\${n}).\`);
  `);
  assert.equal(found.length, 1, 'only the written message is judged');
  assert.match(found[0].text, /Weekly cap/);
});

test('every gate module actually gets scanned', () => {
  // A path typo would make this whole file a no-op.
  for (const file of GATE_FILES) {
    const full = path.join(ROOT, file);
    assert.ok(fs.existsSync(full), `${file} is in GATE_FILES but not on disk`);
    assert.ok(refusals(fs.readFileSync(full, 'utf8')).length > 0, `${file} has no refusals — is the path right?`);
  }
});

test('no refusal in the gate layer is a dead end', () => {
  const deadEnds = [];
  for (const file of GATE_FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const { text, line } of refusals(source)) {
      if (FOUNDER_REMEDY.test(text) || AGENT_REMEDY.test(text) || FINALITY.test(text) || VALIDATION.test(text)) continue;
      deadEnds.push(`  ${file}:${line} — ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
  }

  assert.deepEqual(
    deadEnds,
    [],
    `${deadEnds.length} refusal(s) name no way forward. An agent that reads one of these has nothing to do ` +
      `but try again, which is how a week was lost. Add what the founder does, what the agent does, or say ` +
      `plainly that nothing will change it:\n${deadEnds.join('\n')}`,
  );
});

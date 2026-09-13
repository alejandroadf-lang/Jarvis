// The real library on disk, not a sandboxed one — skills.test.js covers the
// registry's mechanics against fixtures, and this covers the actual skills
// the company ships with.
//
// Five of them were written from failures that happened here, each fluent and
// confident at the time. What's testable is not whether the prose is good but
// whether it reaches the agent that needed it, and whether it still says the
// specific thing it was written to say. A skill edited down to generalities
// is a skill that has stopped changing behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIBRARY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'library');

function read(id) {
  const raw = fs.readFileSync(path.join(LIBRARY, `${id}.md`), 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(match, `${id} has no frontmatter`);
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const agents = (meta.agents || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  return { meta, agents, body: match[2].trim() };
}

test('every skill in the library is offerable', async () => {
  const { AGENTS } = await import('../agents/orgChart.js');
  const { AGENTS: STUDIO } = await import('../agents/ideationTeam.js');
  const known = new Set([...Object.keys(AGENTS), ...Object.keys(STUDIO)]);

  for (const file of fs.readdirSync(LIBRARY).filter((f) => f.endsWith('.md'))) {
    const id = file.replace(/\.md$/, '');
    const skill = read(id);
    assert.equal(skill.meta.name, id, `${id}: the name must match the filename`);
    // Without a description the registry drops it, so it would sit on disk
    // looking like a feature and never reach anyone.
    assert.ok(skill.meta.description, `${id} has no description and would never be offered`);
    for (const agent of skill.agents) {
      assert.ok(known.has(agent), `${id} is assigned to "${agent}", which is not on any roster`);
    }
  }
});

test('the skills written for real failures reach the agents that had them', () => {
  // The CTO reported three confident wrong root causes; the Engineering Lead
  // is where the evidence actually lives.
  const diagnosing = read('diagnosing-a-blocker');
  assert.ok(diagnosing.agents.includes('cto'));
  assert.ok(diagnosing.agents.includes('engineering_lead'));

  // Seven files in one turn was the Engineering Lead's failure, delegated by
  // the CTO — both need to know a turn has a ceiling.
  const sizing = read('sizing-work-for-a-turn');
  assert.ok(sizing.agents.includes('engineering_lead'));
  assert.ok(sizing.agents.includes('cto'));

  // Anyone who reports to the founder can overstate progress to them.
  const reporting = read('reporting-status');
  assert.ok(reporting.agents.includes('ceo'));
  assert.ok(reporting.agents.length >= 8, 'this one is nearly everybody');
});

test('diagnosing-a-blocker keeps the distinction it exists for', () => {
  const body = read('diagnosing-a-blocker').body;
  assert.match(body, /\*\*an absent observation gets promoted to a\s+cause\.\*\*/i);
  assert.match(body, /at least two explanations/i, 'one explanation means you have not looked yet');
  assert.match(body, /\*\*"Confirmed"\*\*/, 'the word that most needs evidence behind it');
});

test('sizing-work-for-a-turn names the real budget, not a vague one', () => {
  // "Break it into smaller pieces" is advice nobody can act on. The number,
  // and why the file counts against it, are the actionable part.
  const body = read('sizing-work-for-a-turn').body;
  assert.match(body, /AGENT_MAX_TOKENS/);
  assert.match(body, /counts against that budget/i);
  assert.match(body, /queue_work/, 'and the tool that makes a dead turn survivable');
});

test('writing-tests-that-assert gives the test for a test', () => {
  const body = read('writing-tests-that-assert').body;
  assert.match(body, /what would I have to break for this to\s+fail/i);
  assert.match(body, /Both directions/, 'the exact case the first venture needs');
});

test('building-a-python-api puts the logic outside the framework', () => {
  // The one structural choice that decides whether the tests stay fast
  // enough that anyone keeps running them.
  const body = read('building-a-python-api').body;
  assert.match(body, /engine imports no framework/i);
  assert.match(body, /workflow_dispatch/, 'without which run_checks has nothing to run');
  assert.match(body, /No secret is ever a literal in source/i);
});

// The five below are not written from failures that already happened here —
// they are written for the work the first venture is about to do, which is the
// other half of what a library is for. What's testable is the same thing: that
// each still carries the one specific claim it exists to make, rather than
// having been edited down into advice that is true of everything.

test('api-authentication refuses the over-built answer and names the leak', () => {
  const body = read('api-authentication').body;
  // The week-long detour this skill exists to prevent.
  assert.match(body, /Not OAuth, not JWTs/);
  // A key you can read out of the database is not a key.
  assert.match(body, /Store a hash, never the key/i);
  // The single most common way a correctly generated key still ends up in
  // plaintext somewhere a support engineer can read it.
  assert.match(body, /Never a query string/);
  // Rate limiting is part of this, not a later feature: a valid key with no
  // limit is the realistic way a retry loop spends the month's budget.
  assert.match(body, /per\s+key, not per IP/i);
});

test('writing-an-api-contract separates what you can change from what you cannot', () => {
  const body = read('writing-an-api-contract').body;
  // Both lists have to be present; the whole value is knowing which side a
  // change falls on before shipping it.
  assert.match(body, /These are \*\*safe\*\* to add after launch/);
  assert.match(body, /These are \*\*breaking\*\*/);
  // The off-by-sixty bug no test catches and no error reports.
  assert.match(body, /Put the unit in the field name/i);
  // The worst failure available, because every HTTP client treats 200 as
  // success.
  assert.match(body, /Never a 200 with/);
});

test('handling-regulated-claims draws the line and puts the disclaimer in the payload', () => {
  const body = read('handling-regulated-claims').body;
  // The distinction that does most of the work, in code and in copy.
  assert.match(body, /what it\s+computed\*\*, never \*\*what the person should do/i);
  // The disclaimer has to reach the person the claim is about, and only the
  // response payload does that — the customer's app renders your JSON.
  assert.match(body, /In the API response payload, as a field/i);
  // And the test is the point: a field dropped by a response filter looks
  // handled in review and is absent in production.
  assert.match(body, /survives\s+serialisation/i);
  // The verbs are the tell — they are what moves a product into
  // medical-device territory.
  assert.match(body, /diagnose, treat, cure, prevent/i);
});

test('finding-first-customers keeps the two things that make it not marketing advice', () => {
  const body = read('finding-first-customers').body;
  // A launch post is an event. Treating it as a channel is why ventures
  // stall right after one.
  assert.match(body, /it is\s+not a channel/i);
  // Compliments are not data. The list of signals that actually count is the
  // operative part.
  assert.match(body, /Tell interest from politeness/i);
  assert.match(body, /they used it, more than once, unprompted/i);
  // Ask about the past: a hypothetical self is always more generous than the
  // person.
  assert.match(body, /Ask about the past, not the future/i);
});

test('pricing-a-product does the margin arithmetic on the worst request, not the average', () => {
  const body = read('pricing-a-product').body;
  // The arithmetic that ends a venture quietly.
  assert.match(body, /worst realistic request/i);
  assert.match(body, /70%/, 'a margin floor, not a vague instruction to watch costs');
  // Pricing the implementation rather than the value: optimise the code and
  // the customer's bill drops.
  assert.match(body, /a unit the customer already counts/i);
  // The signal everyone reads backwards — an instant yes is not good news.
  assert.match(body, /too low/i);
});

test('a skill is long enough to be a procedure and short enough to load', () => {
  // Under a page is a slogan; several pages will not be read mid-task. The
  // check is here so an edit in either direction gets noticed.
  for (const file of fs.readdirSync(LIBRARY).filter((f) => f.endsWith('.md'))) {
    const id = file.replace(/\.md$/, '');
    const { body } = read(id);
    assert.ok(body.length > 800, `${id} is too thin to be a procedure (${body.length} chars)`);
    assert.ok(body.length < 12000, `${id} is too long to load mid-task (${body.length} chars)`);
  }
});

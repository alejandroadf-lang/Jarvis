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

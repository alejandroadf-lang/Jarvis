// Finding customers, as opposed to recommending that someone find customers.
//
// The company produced a daily report whose every go-to-market action was
// addressed to the founder. That read as a lack of initiative and was not: two
// structural facts made proactive GTM impossible, and the team was doing the
// only thing left when it scheduled the work as an objective instead.
//
//   1. No agent that sells could see the internet. RESEARCH_TOOLS reached the
//      Solutions Architect and the SEO Specialist — a technical role and a
//      content role — and nobody in the commercial line.
//   2. The pipeline refused a lead without an email. A prospect found the way
//      prospects are actually found is a username and a URL, so the only place
//      to record one rejected every one discovered by looking.
//
// These tests pin both fixes, and the seam between them: finding someone and
// writing to them are different acts, and only the second reaches a stranger.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS as COMPANY_AGENTS } from '../agents/orgChart.js';
import { resolveModelForAgent } from '../agents/models.js';

let tmpDir;
let ventures;
let handlers;
const saved = {};
const KEYS = ['OPENROUTER_API_KEY', 'REAL_ACTIONS_DISABLED'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-prospecting-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const key of KEYS) saved[key] = process.env[key];
  delete process.env.REAL_ACTIONS_DISABLED;
  ventures = await import('../finance/ventures.js');
  handlers = await import('../actionHandlers.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
});

function newVenture() {
  return ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship'] });
}

// --- Eyes on the commercial side ---------------------------------------------------

test('the agents who sell can see the internet', () => {
  for (const id of ['sales_commercial_manager', 'cmo']) {
    const tools = (COMPANY_AGENTS[id].serverTools || []).map((tool) => tool.name);
    assert.ok(tools.includes('web_search'), `${id} cannot search`);
    assert.ok(tools.includes('web_fetch'), `${id} cannot open what it finds`);
  }
});

// The reason it was these two and not the whole commercial line: a hosted tool
// pins its agent to Anthropic, and these two were already there.
test('giving them eyes moved nobody onto a more expensive model', () => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  for (const id of ['sales_commercial_manager', 'cmo']) {
    assert.equal(resolveModelForAgent(COMPANY_AGENTS[id], true).model, 'claude-sonnet-5');
  }
  // And the one deliberately left without tools is still cheap.
  assert.notEqual(resolveModelForAgent(COMPANY_AGENTS.marketing_manager, true).provider, 'anthropic');
  delete process.env.OPENROUTER_API_KEY;
});

test('the Sales Manager is told to build the list, not to ask for one', () => {
  const prompt = COMPANY_AGENTS.sales_commercial_manager.systemPrompt;
  assert.match(prompt, /Never end a turn having recommended/);
  assert.match(prompt, /handle/);
  assert.match(prompt, /source/);
});

// --- A prospect before anyone has an address ------------------------------------------

test('a lead found in a GitHub issue can be recorded', () => {
  const venture = newVenture();
  const { entry } = ventures.updatePipeline(venture.id, {
    handle: 'gh:alice',
    source: 'https://github.com/x/y/issues/12 — wrote her own jet-lag shift script',
    stage: 'lead',
  });
  assert.equal(entry.handle, 'gh:alice');
  assert.equal(entry.email, '');
  assert.match(entry.source, /issues\/12/);
  assert.equal(ventures.pipelineSummary(venture.id).contacts, 1);
});

// Finding the address later is the normal path, not an edge case. If it made a
// second row, every list would silently double-count.
test('finding the email later moves the row rather than duplicating it', () => {
  const venture = newVenture();
  ventures.updatePipeline(venture.id, { handle: 'gh:alice', source: 'https://github.com/x/y/issues/12', stage: 'lead' });
  const { entry } = ventures.updatePipeline(venture.id, { handle: 'gh:alice', email: 'Alice@Acme.com', stage: 'contacted' });

  const pipeline = ventures.getVenture(venture.id).pipeline;
  assert.deepEqual(Object.keys(pipeline), ['alice@acme.com']);
  assert.equal(entry.handle, 'gh:alice');
  assert.match(entry.source, /issues\/12/, 'and it keeps the evidence that found them');
  assert.equal(ventures.pipelineSummary(venture.id).contacts, 1);
});

test('an entry with neither an email nor a handle is refused, and says what would work', () => {
  const venture = newVenture();
  assert.throws(
    () => ventures.updatePipeline(venture.id, { stage: 'lead' }),
    (err) => /email or a handle/.test(err.message) && /GitHub username/.test(err.message)
  );
});

test('the handler says plainly that a lead with no address cannot be mailed', () => {
  const venture = newVenture();
  const reply = handlers.handleUpdatePipeline(
    { ventureId: venture.id, handle: 'gh:alice', source: 'https://github.com/x/y/issues/12', stage: 'lead' },
    { agentId: 'sales_commercial_manager' }
  );
  assert.match(reply, /gh:alice/);
  assert.match(reply, /No email on this one yet/);
  assert.match(reply, /not a blocker/, 'and does not read as a wall');
});

test('a lead that does have an address says nothing about missing one', () => {
  const venture = newVenture();
  const reply = handlers.handleUpdatePipeline(
    { ventureId: venture.id, email: 'alice@acme.com', stage: 'contacted' },
    { agentId: 'sales_commercial_manager' }
  );
  assert.doesNotMatch(reply, /No email/);
});

// --- The seam: finding is not sending -------------------------------------------------

// Loosening the pipeline must not loosen the door to a real person. A handle
// has no "@" and can never match an allowlist, so the outreach gate is
// unchanged — but that is worth asserting rather than assuming.
test('a handle can never be written to, however it got into the pipeline', () => {
  const venture = newVenture();
  ventures.linkOutreachScope(venture.id, { allowedRecipients: ['@acme.com'] });
  ventures.setOutreachEnabled(venture.id, true);
  ventures.updatePipeline(venture.id, { handle: 'gh:alice', source: 'https://github.com/x/y/issues/12', stage: 'lead' });

  assert.throws(
    () => ventures.authorizeOutreach(venture.id, { to: 'gh:alice' }),
    /outside the allowed recipients/
  );
});

test('the same person becomes writable once a real address is on the row', () => {
  const venture = newVenture();
  ventures.linkOutreachScope(venture.id, { allowedRecipients: ['@acme.com'] });
  ventures.setOutreachEnabled(venture.id, true);
  ventures.updatePipeline(venture.id, { handle: 'gh:alice', source: 'https://github.com/x/y/issues/12', stage: 'lead' });
  ventures.updatePipeline(venture.id, { handle: 'gh:alice', email: 'alice@acme.com' });

  assert.doesNotThrow(() => ventures.authorizeOutreach(venture.id, { to: 'alice@acme.com' }));
});

test('a whole prospect list can be built in one pass', () => {
  const venture = newVenture();
  const found = [
    { handle: 'gh:alice', source: 'https://github.com/a/b/issues/1' },
    { handle: 'gh:bob', source: 'https://github.com/c/d/issues/2' },
    { handle: 'reddit:carol', source: 'https://reddit.com/r/digitalnomad/comments/x' },
  ];
  for (const lead of found) ventures.updatePipeline(venture.id, { ...lead, stage: 'lead' });

  const summary = ventures.pipelineSummary(venture.id);
  assert.equal(summary.contacts, 3);
  assert.equal(summary.byStage.lead, 3);
  // No cap was spent and nobody was contacted: building a list reaches no one.
  assert.deepEqual(ventures.getVenture(venture.id).sentEmails ?? [], []);
});

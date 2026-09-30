// The Road to €1M: every venture, the team's proposals, and the loop back into
// the work. What matters is that it is written from the record rather than
// invented, that the team can see it where they pick their work, that it costs
// one call a week, and that the founder can read it.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let roadmap;
let store;
let ventures;
let ctx;
let commands;
let spend;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-roadmap-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  process.env.DAILY_SPEND_CAP_USD = '100';
  roadmap = await import('../roadmap.js');
  store = await import('../roadmapStore.js');
  ventures = await import('../finance/ventures.js');
  ctx = await import('../finance/context.js');
  commands = await import('../channels/founderCommands.js');
  spend = await import('../spend.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  delete process.env.DAILY_SPEND_CAP_USD;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true, recursive: true });
});

const reply = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: { input_tokens: 100, output_tokens: 50 } });
function client(text, seen = []) {
  return { messages: { create: async (p) => { seen.push(p); return reply(text); } } };
}

test('the aim is a number in one place, and the kickoff asks for facts, not invention', () => {
  assert.equal(ventures.REVENUE_GOAL_EUR, 1_000_000);
  const kick = roadmap.roadmapKickoff('2026-09-30');
  assert.match(kick, /€1,000,000 a year in recurring revenue/);
  assert.match(kick, /write "not recorded": do not invent a market size, a conversion rate or a customer/);
  assert.match(kick, /Three improvements, ranked/);
  assert.match(kick, /the work sessions take each venture's top improvement/);
});

test('nothing is written without an active venture', async () => {
  const seen = [];
  assert.equal(await roadmap.runRoadmap({ anthropic: client('x', seen) }), null);
  assert.equal(seen.length, 0, 'no model call for nothing to write about');
  assert.deepEqual(await roadmap.ensureRoadmap({ anthropic: client('x') }), { ran: false, reason: 'no active venture' });
});

test('it is written by the CEO alone, with no tools, and stored and attributed', async () => {
  ventures.createVenture({ title: 'Happy Company', oneLiner: 'x', proposedBy: 'founder' });
  const seen = [];
  const written = await roadmap.runRoadmap({ anthropic: client('## Happy Company\nNot recorded.', seen) });
  assert.equal(written.text, '## Happy Company\nNot recorded.');
  assert.equal(store.getLatestRoadmap().text, written.text);

  assert.equal(seen.length, 1, 'one call: no fan-out');
  // Nothing to consult, act with or search on; the free, read-only skill loader
  // is the one tool the CEO always carries.
  const names = (seen[0].tools || []).map((t) => t.name);
  assert.deepEqual(names.filter((n) => n !== 'load_skill'), [], 'no consult, action or search tool');
  assert.deepEqual(spend.spendBreakdown(7).bySource.map(([n]) => n), ['roadmap']);
});

test('a roadmap under a week old is left alone; an old or missing one is rewritten', async () => {
  ventures.createVenture({ title: 'Happy Company', oneLiner: 'x', proposedBy: 'founder' });
  assert.deepEqual(await roadmap.ensureRoadmap({ anthropic: client('first') }), { ran: true });
  const seen = [];
  assert.equal((await roadmap.ensureRoadmap({ anthropic: client('second', seen) })).ran, false);
  assert.equal(seen.length, 0);
  assert.equal(store.getLatestRoadmap().text, 'first');

  const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await roadmap.ensureRoadmap({ anthropic: client('second'), now: later }), { ran: true });
  assert.equal(store.getLatestRoadmap().text, 'second');
});

test('a failed write is reported and never thrown into the morning', async () => {
  ventures.createVenture({ title: 'Happy Company', oneLiner: 'x', proposedBy: 'founder' });
  const failing = { messages: { create: async () => { throw new Error('provider down'); } } };
  const result = await roadmap.ensureRoadmap({ anthropic: failing });
  assert.equal(result.ran, false);
  assert.equal(store.getLatestRoadmap(), null);
});

test('the team reads the aim and the latest proposals where they pick their work, capped', () => {
  assert.match(ctx.buildCompanyContext(), /The founder's aim: every venture on the road to €1,000,000 a year/);
  assert.match(ctx.buildCompanyContext(), /No Road to €1M has been written yet; the next daily meeting writes the first/);

  store.saveRoadmap({ text: 'Circadian: price to €12.\n' + 'x'.repeat(5000) });
  const text = ctx.buildCompanyContext();
  assert.match(text, /a venture's top improvement here is its next piece of work/);
  assert.match(text, /Circadian: price to €12\./);
  assert.ok(text.length < 60_000);
  assert.ok(!text.includes('x'.repeat(2000)), 'capped: it rides on every call');
  assert.ok(!ctx.buildStudioContext().includes('Circadian: price to €12.'), 'the Studio does not read it');
});

test('ROADMAP shows the latest to the founder, or says when the first comes', async () => {
  assert.match(await commands.runFounderCommand({ kind: 'roadmap' }), /No Road to €1M has been written yet.*next daily meeting/);
  store.saveRoadmap({ text: '## Happy Company\nTop improvement: a price.' });
  const shown = await commands.runFounderCommand({ kind: 'roadmap' });
  assert.match(shown, /Road to €1M, written \d{4}-\d{2}-\d{2}/);
  assert.match(shown, /Top improvement: a price\./);
  assert.deepEqual(commands.parseFounderCommand('ROADMAP'), { kind: 'roadmap' });
  assert.equal(commands.parseFounderCommand('roadmap for the launch please'), null, 'prose is not a command');
  assert.match(commands.__helpForTests, /ROADMAP — /);
});

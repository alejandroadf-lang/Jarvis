// What the team went looking for.
//
// The measured confirmation bias in research agents sits in which evidence is
// selected, not how it is read. That makes it invisible in the output: every
// citation shown genuinely supports the claim, because the disconfirming
// sources were never retrieved. Ten searches beginning "benefits of" and five
// beginning "why did X fail" produce write-ups that read identically.
//
// So the queries are captured from the model's own response blocks rather than
// reported by the agent — a self-reported search history is a claim, and the
// point of this file is to have something that is not.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let log;
let commands;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-searchlog-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  log = await import('../searchLog.js');
  commands = await import('../channels/founderCommands.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'searchLog.json'), { force: true });
});

function searchBlock(query) {
  return { type: 'server_tool_use', name: 'web_search', input: { query } };
}

// --- Capture ------------------------------------------------------------------------

test('queries are pulled from the response, not from what the agent says it did', () => {
  const recorded = log.recordSearchesFrom(
    [
      { type: 'text', text: 'I searched thoroughly for counter-evidence.' },
      searchBlock('circadian api market size'),
      searchBlock('why did jet lag apps fail'),
    ],
    'market_researcher'
  );
  assert.equal(recorded.length, 2, 'the prose claim is not a search');
  assert.deepEqual(recorded.map((r) => r.query), ['circadian api market size', 'why did jet lag apps fail']);
});

test('other block types are ignored', () => {
  const recorded = log.recordSearchesFrom(
    [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'deploy_code', input: { path: 'src/a.py' } },
      { type: 'server_tool_use', name: 'web_fetch', input: { url: 'https://example.com' } },
    ],
    'engineering_lead'
  );
  assert.deepEqual(recorded, []);
});

test('malformed content is survivable', () => {
  assert.deepEqual(log.recordSearchesFrom(null, 'x'), []);
  assert.deepEqual(log.recordSearchesFrom([{ type: 'server_tool_use', name: 'web_search' }], 'x'), []);
  assert.deepEqual(log.recordSearchesFrom([searchBlock('   ')], 'x'), []);
});

// --- Classification -------------------------------------------------------------------

test('queries that go looking for the counter-case are marked', () => {
  for (const query of [
    'why did circadian startups fail',
    'jet lag api problems',
    'circadian api competitors',
    'criticism of chronobiology apps',
    'who else already built this',
    'jet lag app lawsuit',
  ]) {
    assert.equal(log.looksDisconfirming(query), true, `"${query}" should read as disconfirming`);
  }
});

test('ordinary supportive queries are not', () => {
  for (const query of ['circadian api market size 2026', 'jet lag prevalence business travellers', 'chronobiology research funding']) {
    assert.equal(log.looksDisconfirming(query), false, `"${query}" should not read as disconfirming`);
  }
});

// --- The number the founder actually reads ------------------------------------------------

test('the balance is a ratio per agent, not a verdict', () => {
  log.recordSearch({ agentId: 'market_researcher', query: 'market size' });
  log.recordSearch({ agentId: 'market_researcher', query: 'why did this fail' });
  log.recordSearch({ agentId: 'scale_strategist', query: 'tam estimate' });

  const balance = log.searchBalance();
  assert.equal(balance.total, 3);
  assert.equal(balance.disconfirming, 1);
  assert.equal(balance.agents.market_researcher.total, 2);
  assert.equal(balance.agents.market_researcher.disconfirming, 1);
  assert.equal(balance.agents.scale_strategist.disconfirming, 0);
});

// The case worth naming out loud, because it is the one the output cannot show.
test('a pass with no disconfirming query says so in as many words', () => {
  log.recordSearch({ agentId: 'market_researcher', query: 'benefits of circadian apis' });
  log.recordSearch({ agentId: 'market_researcher', query: 'circadian api market size' });

  const text = log.describeSearchBalance();
  assert.match(text, /0 \(0%\)/);
  assert.match(text, /read the same way if the idea were bad/);
});

test('a balanced pass is reported without the warning', () => {
  log.recordSearch({ agentId: 'market_researcher', query: 'market size' });
  log.recordSearch({ agentId: 'market_researcher', query: 'why did competitors fail' });
  const text = log.describeSearchBalance();
  assert.match(text, /1 \(50%\)/);
  assert.doesNotMatch(text, /read the same way/);
});

test('nothing searched means nothing said', () => {
  assert.equal(log.describeSearchBalance(), '');
});

test('the since filter only counts this run', () => {
  log.recordSearch({ agentId: 'market_researcher', query: 'old query', at: '2020-01-01T00:00:00.000Z' });
  log.recordSearch({ agentId: 'market_researcher', query: 'why did this fail', at: '2026-09-19T10:00:00.000Z' });

  const balance = log.searchBalance({ since: '2026-09-19T00:00:00.000Z' });
  assert.equal(balance.total, 1);
  assert.equal(balance.disconfirming, 1);
});

// --- The founder's view -------------------------------------------------------------------

test('SEARCHES parses and lists the queries with the marker', async () => {
  assert.deepEqual(commands.parseFounderCommand('SEARCHES'), { kind: 'searches' });
  assert.equal(commands.parseFounderCommand('what did we search for'), null);

  log.recordSearch({ agentId: 'market_researcher', query: 'circadian api market size' });
  log.recordSearch({ agentId: 'market_researcher', query: 'why did jet lag apps fail' });

  const reply = await commands.runFounderCommand({ kind: 'searches' }, {});
  assert.match(reply, /circadian api market size/);
  assert.match(reply, /↯ market_researcher: why did jet lag apps fail/);
});

test('with an empty log it says where the data would come from', async () => {
  const reply = await commands.runFounderCommand({ kind: 'searches' }, {});
  assert.match(reply, /not self-reported/);
});

test('the help text lists it', () => {
  assert.match(commands.__helpForTests, /SEARCHES —/);
});

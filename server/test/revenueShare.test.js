// The contribution table was quietly telling the company the wrong thing:
//
//   deploy_code:  weight 5      shipping a file
//   log_revenue:  weight 1      booking actual money
//
// An agent that shipped ten files out-earned one whose work brought in ten
// thousand dollars, fifty to one. No prompt about a "money mindset" survives
// an incentive pointing the other way.
//
// The hole was not that log_revenue paid too little — logging is clerical,
// the founder reports the money and an agent writes it down, and paying more
// for typing would reward clerking. It was that nothing rewarded *causing*
// revenue: credit was recorded the moment an action succeeded and the
// outcome never fed back, so the email to the customer who paid earned
// exactly what the email to the customer who ignored it did.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let share;
const savedRate = process.env.REVENUE_WEIGHT_PER_USD;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-revshare-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  delete process.env.REVENUE_WEIGHT_PER_USD;
  share = await import('../finance/profitShare.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedRate === undefined) delete process.env.REVENUE_WEIGHT_PER_USD;
  else process.env.REVENUE_WEIGHT_PER_USD = savedRate;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'profitShare.json'), { force: true });
  delete process.env.REVENUE_WEIGHT_PER_USD;
});

function weightOf(agentId) {
  return share.listContributions(agentId).reduce((sum, c) => sum + c.weight, 0);
}

test('one real customer outweighs a week of commits', () => {
  // The behaviour change in one assertion. Before this existed, shipper won.
  share.recordContribution({ agentId: 'shipper', kind: 'deploy_code', ventureId: 'v_other' });
  for (let i = 0; i < 9; i += 1) {
    share.recordContribution({ agentId: 'shipper', kind: 'deploy_code', ventureId: 'v_other' });
  }
  share.recordContribution({ agentId: 'seller', kind: 'send_customer_email', ventureId: 'v_earning' });
  share.distributeRevenue({ ventureId: 'v_earning', amountUsd: 10000 });

  assert.equal(weightOf('shipper'), 50, 'ten shipped files');
  assert.ok(weightOf('seller') > weightOf('shipper'), 'and the one that earned still wins');
});

test('credit is split by work actually done on that venture', () => {
  share.recordContribution({ agentId: 'engineer', kind: 'deploy_code', ventureId: 'v_1' }); // 5
  share.recordContribution({ agentId: 'seller', kind: 'send_customer_email', ventureId: 'v_1' }); // 3
  share.distributeRevenue({ ventureId: 'v_1', amountUsd: 1000 });

  // $1000 at the default rate is a pot of 50, split 5:3.
  const credits = share.listContributions().filter((c) => c.kind === 'revenue_earned');
  assert.equal(credits.length, 2);
  const byAgent = Object.fromEntries(credits.map((c) => [c.agentId, c.weight]));
  assert.equal(byAgent.engineer, 31.25);
  assert.equal(byAgent.seller, 18.75);
  assert.equal(byAgent.engineer + byAgent.seller, 50);
});

test('an agent with no work on the venture gets nothing from it', () => {
  // This is a share of *this* outcome, not a dividend on being busy.
  share.recordContribution({ agentId: 'onit', kind: 'deploy_code', ventureId: 'v_1' });
  share.recordContribution({ agentId: 'elsewhere', kind: 'deploy_code', ventureId: 'v_2' });
  share.distributeRevenue({ ventureId: 'v_1', amountUsd: 500 });

  const credits = share.listContributions('elsewhere').filter((c) => c.kind === 'revenue_earned');
  assert.equal(credits.length, 0);
});

test('earlier revenue is not part of the basis for later revenue', () => {
  // Compounding would mean the first customer makes every later customer pay
  // the same agents more, regardless of who did the work in between.
  share.recordContribution({ agentId: 'a', kind: 'deploy_code', ventureId: 'v_1' });
  share.distributeRevenue({ ventureId: 'v_1', amountUsd: 1000 });
  const afterFirst = weightOf('a');

  share.recordContribution({ agentId: 'b', kind: 'deploy_code', ventureId: 'v_1' });
  share.distributeRevenue({ ventureId: 'v_1', amountUsd: 1000 });

  // Second round splits evenly: both have 5 of non-revenue weight.
  assert.equal(weightOf('a') - afterFirst, 25);
  assert.equal(weightOf('b'), 5 + 25);
});

test('revenue on a venture nobody worked on credits nobody', () => {
  // Possible after history is compacted, or for a venture the founder ran
  // themselves. Crediting everybody would be worse than crediting nobody.
  assert.deepEqual(share.distributeRevenue({ ventureId: 'v_ghost', amountUsd: 5000 }), []);
});

test('nothing is credited without a venture, an amount, or a positive one', () => {
  share.recordContribution({ agentId: 'a', kind: 'deploy_code', ventureId: 'v_1' });
  assert.deepEqual(share.distributeRevenue({ ventureId: null, amountUsd: 100 }), []);
  assert.deepEqual(share.distributeRevenue({ ventureId: 'v_1', amountUsd: 0 }), []);
  assert.deepEqual(share.distributeRevenue({ ventureId: 'v_1', amountUsd: -100 }), []);
  assert.deepEqual(share.distributeRevenue({ ventureId: 'v_1', amountUsd: 'lots' }), []);
});

test('the rate is a judgement, and changeable', () => {
  // $100 of revenue equals one shipped file by default. That ratio is chosen,
  // not discovered, and the right number becomes obvious once there is any
  // revenue to look at.
  process.env.REVENUE_WEIGHT_PER_USD = '0.5';
  share.recordContribution({ agentId: 'a', kind: 'deploy_code', ventureId: 'v_1' });
  share.distributeRevenue({ ventureId: 'v_1', amountUsd: 100 });
  assert.equal(weightOf('a'), 5 + 50);
});

test('a blank rate falls back rather than paying nothing', () => {
  // The blank-env trap, for the third time in this codebase. Here it would
  // silently switch the whole mechanism off while looking configured.
  process.env.REVENUE_WEIGHT_PER_USD = '   ';
  share.recordContribution({ agentId: 'a', kind: 'deploy_code', ventureId: 'v_1' });
  share.distributeRevenue({ ventureId: 'v_1', amountUsd: 1000 });
  assert.equal(weightOf('a'), 5 + 50);
});

test('the share still cannot be claimed, only recorded', () => {
  // Every other guardrail holds: there is no tool that reaches this, the
  // amount comes from the founder, and the recipients come from work already
  // on record.
  assert.equal(typeof share.distributeRevenue, 'function');
  assert.equal(share.CONTRIBUTION_KINDS.revenue_earned.weight, 0, 'the amount is the weight, not the table');
});

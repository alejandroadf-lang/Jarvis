// What's tested here is refusal. The permissive paths are easy and mostly
// obvious; the value of this layer is entirely in the cases where it says no,
// and in the log being trustworthy afterwards.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createActionGate, createMemoryStore, ActionDenied } from '../src/index.js';
import type { ActionStore } from '../src/index.js';

let store: ActionStore;

beforeEach(() => {
  store = createMemoryStore();
});

const REQ = { ventureId: 'v1', agentId: 'sales_manager', action: 'send_email', target: 'a@b.com' };

async function grant(extra: Record<string, unknown> = {}) {
  await store.putScope({ ventureId: 'v1', action: 'send_email', enabled: true, ...extra });
}

test('an action with no scope is refused — nothing is permitted by default', async () => {
  const gate = createActionGate({ store });

  await assert.rejects(
    () => gate.perform(REQ, async () => 'sent'),
    (err: ActionDenied) => err.code === 'no_scope'
  );
});

test('a granted-but-disabled scope is refused, so switching off is instant', async () => {
  await grant({ enabled: false });
  const gate = createActionGate({ store });

  await assert.rejects(() => gate.perform(REQ, async () => 'sent'), /switched off/);
});

test('the halt refuses everything, whatever the scopes say', async () => {
  await grant();
  const gate = createActionGate({ store });
  await gate.halt('founder pulled the cord');

  await assert.rejects(() => gate.perform(REQ, async () => 'sent'), /founder pulled the cord/);

  await gate.resume();
  const { result } = await gate.perform(REQ, async () => 'sent');
  assert.equal(result, 'sent');
});

test('an empty allowlist permits nothing — it does not mean "anything"', async () => {
  // The single most dangerous misreading in a scope system.
  await grant({ allowedTargets: [] });
  const gate = createActionGate({ store });

  await assert.rejects(
    () => gate.perform(REQ, async () => 'sent'),
    (err: ActionDenied) => err.code === 'target_not_allowed'
  );
});

test('an allowlist admits what is on it and refuses what is not', async () => {
  await grant({ allowedTargets: ['known@customer.com'] });
  const gate = createActionGate({ store });

  const { result } = await gate.perform({ ...REQ, target: 'known@customer.com' }, async () => 'sent');
  assert.equal(result, 'sent');

  await assert.rejects(() => gate.perform({ ...REQ, target: 'stranger@example.com' }, async () => 'sent'));
});

test('the cooldown stops a loop firing the same action repeatedly', async () => {
  await grant({ cooldownMs: 60_000 });
  const gate = createActionGate({ store });

  await gate.perform(REQ, async () => 'first');
  await assert.rejects(
    () => gate.perform(REQ, async () => 'second'),
    (err: ActionDenied) => err.code === 'cooldown' && /left on the cooldown/.test(err.message)
  );
});

test('the daily cap counts allowed actions and then refuses', async () => {
  await grant({ maxPerDay: 2 });
  const gate = createActionGate({ store });

  await gate.perform(REQ, async () => 1);
  await gate.perform(REQ, async () => 2);
  await assert.rejects(
    () => gate.perform(REQ, async () => 3),
    (err: ActionDenied) => err.code === 'daily_cap'
  );
});

test('a failed action does not consume the quota', async () => {
  // A send that errored did not reach anyone, so counting it would let a
  // flaky provider silently eat the day's allowance.
  await grant({ maxPerDay: 1 });
  const gate = createActionGate({ store });

  await assert.rejects(() => gate.perform(REQ, async () => { throw new Error('smtp timeout'); }));

  const { result } = await gate.perform(REQ, async () => 'sent on the retry');
  assert.equal(result, 'sent on the retry');
});

test('the spend cap refuses the action that would cross it, not the one after', async () => {
  await grant();
  const gate = createActionGate({ store, dailySpendCapUsd: 10 });

  await gate.perform({ ...REQ, costUsd: 7 }, async () => 'ok');
  await assert.rejects(
    () => gate.perform({ ...REQ, costUsd: 5 }, async () => 'ok'),
    (err: ActionDenied) => err.code === 'spend_cap'
  );

  // Something that fits still goes through.
  const { result } = await gate.perform({ ...REQ, costUsd: 3 }, async () => 'ok');
  assert.equal(result, 'ok');
});

test('a refused action never costs anything', async () => {
  await grant({ maxPerDay: 0 });
  const gate = createActionGate({ store, dailySpendCapUsd: 100 });

  await assert.rejects(() => gate.perform({ ...REQ, costUsd: 50 }, async () => 'ok'));

  const { spentUsd } = await gate.spendToday();
  assert.equal(spentUsd, 0);
});

// --- The log ----------------------------------------------------------------

test('a refusal is recorded, because a denial is evidence', async () => {
  const gate = createActionGate({ store });

  await assert.rejects(() => gate.perform(REQ, async () => 'sent'));

  const [entry] = await gate.recent(10);
  assert.equal(entry!.outcome, 'denied');
  assert.equal(entry!.agentId, 'sales_manager');
  assert.match(entry!.reason!, /No scope/);
});

test('a failure is logged as failed, distinct from allowed and denied', async () => {
  await grant();
  const gate = createActionGate({ store });

  await assert.rejects(() => gate.perform(REQ, async () => { throw new Error('smtp timeout'); }));

  const [entry] = await gate.recent(10);
  assert.equal(entry!.outcome, 'failed');
  assert.match(entry!.reason!, /smtp timeout/);
});

test('the work never runs unless the gate allowed it', async () => {
  let ran = false;
  const gate = createActionGate({ store });

  await assert.rejects(() => gate.perform(REQ, async () => { ran = true; return 'x'; }));

  assert.equal(ran, false, 'a refused action must not have side effects');
});

test('the rationale is kept, so a decision can be reviewed later', async () => {
  await grant();
  const gate = createActionGate({ store });

  await gate.perform({ ...REQ, rationale: 'They asked for pricing on Tuesday.' }, async () => 'sent');

  const [entry] = await gate.recent(10);
  assert.equal(entry!.rationale, 'They asked for pricing on Tuesday.');
});

test('a listener that throws cannot break the action or the log', async () => {
  await grant();
  const gate = createActionGate({
    store,
    onEntry: () => { throw new Error('alerting is down'); },
  });

  const { result } = await gate.perform(REQ, async () => 'sent');
  assert.equal(result, 'sent');
  assert.equal((await gate.recent(10)).length, 1);
});

test('wouldAllow answers without performing anything', async () => {
  const gate = createActionGate({ store });

  const before = await gate.wouldAllow(REQ);
  assert.equal(before.allowed, false);
  assert.match(before.reason!, /No scope/);

  await grant();
  assert.equal((await gate.wouldAllow(REQ)).allowed, true);
});

test('scopes are per venture — granting one does not grant another', async () => {
  await grant();
  const gate = createActionGate({ store });

  await gate.perform(REQ, async () => 'ok');
  await assert.rejects(
    () => gate.perform({ ...REQ, ventureId: 'v2' }, async () => 'ok'),
    (err: ActionDenied) => err.code === 'no_scope'
  );
});

test('caps are per action kind — a full email quota does not block a deploy', async () => {
  await grant({ maxPerDay: 1 });
  await store.putScope({ ventureId: 'v1', action: 'deploy_code', enabled: true, maxPerDay: 1 });
  const gate = createActionGate({ store });

  await gate.perform(REQ, async () => 'emailed');
  await assert.rejects(() => gate.perform(REQ, async () => 'emailed again'));

  const { result } = await gate.perform(
    { ventureId: 'v1', agentId: 'eng_lead', action: 'deploy_code', target: 'src/x.ts' },
    async () => 'shipped'
  );
  assert.equal(result, 'shipped');
});

// No real database here — what's checked is the translation, which is where
// the bugs of this kind actually live. The null-versus-empty-array mapping in
// particular: get it wrong and a scope that permits nothing starts permitting
// everything, silently and in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresStore } from '../src/index.js';
import type { QueryablePool } from '../src/index.js';

function fakePool(rowsFor: (sql: string, values?: unknown[]) => any[]): QueryablePool & { calls: { sql: string; values?: unknown[] }[] } {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: rowsFor(sql, values) };
    },
  };
}

test('a NULL allowed_targets means "no allowlist", not "allow nothing"', async () => {
  const pool = fakePool(() => [
    { venture_id: 'v1', action: 'deploy_code', enabled: true, allowed_targets: null, max_per_day: null, max_per_week: null, cooldown_ms: null },
  ]);

  const scope = await createPostgresStore(pool).getScope('v1', 'deploy_code');

  // undefined is what the gate reads as "this action has no target rule".
  assert.equal(scope!.allowedTargets, undefined);
});

test('an empty allowed_targets array survives as an empty array', async () => {
  const pool = fakePool(() => [
    { venture_id: 'v1', action: 'send_email', enabled: true, allowed_targets: [], max_per_day: null, max_per_week: null, cooldown_ms: null },
  ]);

  const scope = await createPostgresStore(pool).getScope('v1', 'send_email');

  // The gate refuses everything against this. Turning it into undefined here
  // would open the scope wide, which is the failure this test exists for.
  assert.deepEqual(scope!.allowedTargets, []);
});

test('a missing scope reads as null rather than an empty object', async () => {
  const pool = fakePool(() => []);
  assert.equal(await createPostgresStore(pool).getScope('v1', 'anything'), null);
});

test('rate counting asks only for allowed rows in the window', async () => {
  const pool = fakePool(() => [{ n: 3 }]);
  const since = new Date('2026-01-01T00:00:00Z');

  const count = await createPostgresStore(pool).countAllowedSince('v1', 'send_email', since);

  assert.equal(count, 3);
  const [call] = pool.calls;
  assert.match(call!.sql, /outcome = 'allowed'/, 'denied and failed rows must not count towards a cap');
  assert.deepEqual(call!.values, ['v1', 'send_email', since]);
});

test('spend is summed from the log, not read from a counter', async () => {
  const pool = fakePool(() => [{ total: 12.5 }]);

  const total = await createPostgresStore(pool).getSpendToday();

  assert.equal(total, 12.5);
  assert.match(pool.calls[0]!.sql, /sum\(cost_usd\)/, 'the cap must enforce a number reconstructible from the evidence');
  assert.match(pool.calls[0]!.sql, /date_trunc\('day', now\(\)\)/);
});

test('appending writes every field the audit needs', async () => {
  const pool = fakePool(() => []);
  const at = new Date('2026-02-03T04:05:06Z');

  await createPostgresStore(pool).append({
    at,
    ventureId: 'v1',
    agentId: 'sales_manager',
    action: 'send_email',
    target: 'a@b.com',
    outcome: 'denied',
    reason: 'not on the allowlist',
    rationale: 'they asked',
    costUsd: 0.02,
    detail: { messageId: 'm-1' },
  });

  const [call] = pool.calls;
  assert.match(call!.sql, /insert into action_log/);
  assert.deepEqual(call!.values, [
    at, 'v1', 'sales_manager', 'send_email', 'a@b.com', 'denied',
    'not on the allowlist', 'they asked', 0.02, '{"messageId":"m-1"}',
  ]);
});

test('reading the log back restores dates and drops SQL nulls', async () => {
  const pool = fakePool(() => [
    {
      id: 7, at: '2026-02-03T04:05:06.000Z', venture_id: 'v1', agent_id: 'a', action: 'send_email',
      target: null, outcome: 'allowed', reason: null, rationale: null, cost_usd: null, detail: null,
    },
  ]);

  const [entry] = await createPostgresStore(pool).recent(10);

  assert.equal(entry!.id, '7');
  assert.ok(entry!.at instanceof Date);
  assert.equal(entry!.target, undefined, 'a SQL null must not leak out as the string "null"');
  assert.equal(entry!.costUsd, undefined);
});

test('putScope stores no allowlist as NULL and an empty one as an array', async () => {
  const pool = fakePool(() => []);
  const store = createPostgresStore(pool);

  await store.putScope({ ventureId: 'v1', action: 'deploy_code', enabled: true });
  await store.putScope({ ventureId: 'v1', action: 'send_email', enabled: true, allowedTargets: [] });

  assert.equal(pool.calls[0]!.values![3], null);
  assert.deepEqual(pool.calls[1]!.values![3], []);
});

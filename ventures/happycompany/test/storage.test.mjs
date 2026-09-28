import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgeStore, memoryStore } from '../src/storage.mjs';

// A fake @forge/kvs that pages query results the way the real one does.
function fakeKvs(entries, pageSize = 2) {
  const data = new Map(Object.entries(entries));
  const WhereConditions = { beginsWith: (p) => ({ beginsWith: p }) };
  const kvs = {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
    getSecret: async (k) => data.get(`secret:${k}`),
    setSecret: async (k, v) => void data.set(`secret:${k}`, v),
    query() {
      const q = { prefix: '', start: 0 };
      return {
        where(_field, cond) {
          q.prefix = cond.beginsWith;
          return this;
        },
        limit() {
          return this;
        },
        cursor(c) {
          q.start = Number(c);
          return this;
        },
        async getMany() {
          const all = [...data.entries()].filter(([k]) => k.startsWith(q.prefix)).sort();
          const page = all.slice(q.start, q.start + pageSize).map(([key, value]) => ({ key, value }));
          const next = q.start + pageSize < all.length ? String(q.start + pageSize) : undefined;
          return { results: page, nextCursor: next };
        },
      };
    },
  };
  return { kvs, WhereConditions, data };
}

test('a prefix listing follows every cursor', async () => {
  const { kvs, WhereConditions } = fakeKvs({ 'day:a:1': 1, 'day:a:2': 2, 'day:a:3': 3, 'day:a:4': 4, 'day:a:5': 5, 'day:b:1': 9 });
  const store = forgeStore(kvs, WhereConditions);
  const rows = await store.list('day:a:');
  assert.deepEqual(
    rows.map((r) => r.value),
    [1, 2, 3, 4, 5],
  );
  assert.equal(await store.get('day:b:1'), 9);
  await store.setSecret('salt', 's');
  assert.equal(await store.getSecret('salt'), 's');
});

test('the memory store behaves the same way and hands out copies', async () => {
  const store = memoryStore();
  const bucket = { total: 1 };
  await store.set('day:a:1', bucket);
  bucket.total = 99;
  assert.equal((await store.get('day:a:1')).total, 1);
  await store.set('day:b:1', 2);
  assert.deepEqual((await store.list('day:a:')).map((r) => r.key), ['day:a:1']);
  await store.delete('day:a:1');
  assert.equal(await store.get('day:a:1'), undefined);
});

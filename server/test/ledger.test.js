import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ledger;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ledger-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  ledger = await import('../finance/ledger.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('starts from seed capital with no other transactions', () => {
  const { balance, startingCapital, transactions } = ledger.getLedger();
  assert.equal(balance, ledger.STARTING_CAPITAL);
  assert.equal(startingCapital, ledger.STARTING_CAPITAL);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].type, 'capital');
});

test('investment and expense subtract from balance, revenue adds', () => {
  const before = ledger.getBalance();
  ledger.addTransaction({ type: 'investment', amount: 30, description: 'seed a venture' });
  assert.equal(ledger.getBalance(), before - 30);

  ledger.addTransaction({ type: 'expense', amount: 5, description: 'hosting' });
  assert.equal(ledger.getBalance(), before - 35);

  ledger.addTransaction({ type: 'revenue', amount: 12, description: 'first sale' });
  assert.equal(ledger.getBalance(), before - 23);
});

test('rejects an unknown transaction type', () => {
  assert.throws(() => ledger.addTransaction({ type: 'bogus', amount: 10 }), /Invalid transaction type/);
});

test('rejects a non-positive amount', () => {
  assert.throws(() => ledger.addTransaction({ type: 'revenue', amount: 0 }), /positive number/);
  assert.throws(() => ledger.addTransaction({ type: 'revenue', amount: -5 }), /positive number/);
});

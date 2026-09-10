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

test('starts empty — no seed capital, nothing earned, nothing spent', () => {
  const { revenue, expenses, net, transactions } = ledger.getLedger();
  assert.equal(revenue, 0);
  assert.equal(expenses, 0);
  assert.equal(net, 0);
  assert.equal(transactions.length, 0);
});

test('revenue adds to net, expense subtracts from it', () => {
  ledger.addTransaction({ type: 'revenue', amount: 12, description: 'first sale' });
  assert.deepEqual(pick(ledger.getLedger()), { revenue: 12, expenses: 0, net: 12 });

  ledger.addTransaction({ type: 'expense', amount: 5, description: 'hosting' });
  assert.deepEqual(pick(ledger.getLedger()), { revenue: 12, expenses: 5, net: 7 });

  ledger.addTransaction({ type: 'expense', amount: 20, description: 'a domain' });
  // Net going negative is a real state here, not an error: there is no
  // balance to run out of, so spending ahead of revenue is allowed and
  // simply shows up as a loss.
  assert.deepEqual(pick(ledger.getLedger()), { revenue: 12, expenses: 25, net: -13 });
});

test('rejects an unknown transaction type', () => {
  assert.throws(() => ledger.addTransaction({ type: 'bogus', amount: 10 }), /Invalid transaction type/);
});

// 'investment' and 'capital' belonged to the old seed-capital model. They're
// gone deliberately, so a caller still trying to allocate money should fail
// loudly rather than quietly booking something the books no longer mean.
test('rejects the retired capital-model transaction types', () => {
  assert.throws(() => ledger.addTransaction({ type: 'investment', amount: 30 }), /Invalid transaction type/);
  assert.throws(() => ledger.addTransaction({ type: 'capital', amount: 100 }), /Invalid transaction type/);
});

test('rejects a non-positive amount', () => {
  assert.throws(() => ledger.addTransaction({ type: 'revenue', amount: 0 }), /positive number/);
  assert.throws(() => ledger.addTransaction({ type: 'revenue', amount: -5 }), /positive number/);
});

function pick({ revenue, expenses, net }) {
  return { revenue, expenses, net };
}

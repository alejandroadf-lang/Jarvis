// The company's books: real money that has come in, and real money that has
// gone out. Nothing else.
//
// This used to model a $100 seed the company allocated to ventures in
// tranches, which turned out to be measuring a cost this company doesn't
// have. The expensive input in a normal business is people, and here the
// people are agents — their marginal cost is model spend, which is metered
// and capped separately (see server/spend.js) rather than pretended to be
// venture capital. So there's no seed, no allocation, and no balance to run
// out of; a venture is never blocked for lack of capital.
//
// What remains is genuinely real: revenue a venture actually earned, and
// expenses actually paid (a domain, an ad test, a subscription). Still a
// flat transaction log rather than a mutable total, so every figure is a
// fold over auditable history.

import { readJson, writeJson } from '../store.js';

const FILE = 'ledger.json';

const VALID_TYPES = ['expense', 'revenue'];

function load() {
  return readJson(FILE, { transactions: [] });
}

function sumType(transactions, type) {
  return transactions.filter((tx) => tx.type === type).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
}

export function getLedger() {
  const { transactions } = load();
  const revenue = sumType(transactions, 'revenue');
  const expenses = sumType(transactions, 'expense');
  return { revenue, expenses, net: revenue - expenses, transactions };
}

export function addTransaction({ type, amount, description = '', ventureId = null }) {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid transaction type: ${type}. Must be one of ${VALID_TYPES.join(', ')}`);
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('amount must be a positive number');
  }

  const data = load();
  const tx = {
    id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    amount: numericAmount,
    description,
    ventureId,
    createdAt: new Date().toISOString(),
  };
  data.transactions.push(tx);
  writeJson(FILE, data);
  return tx;
}

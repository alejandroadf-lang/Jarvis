// The company's treasury: starts from a fixed seed capital and tracks every
// dollar allocated to a venture or earned back from one. Deliberately a
// flat transaction log rather than a mutable balance field, so the balance
// is always just a fold over history and every change is auditable.

import { readJson, writeJson } from './store.js';

const FILE = 'ledger.json';
export const STARTING_CAPITAL = 100;

const VALID_TYPES = ['capital', 'investment', 'expense', 'revenue'];

function load() {
  return readJson(FILE, {
    transactions: [
      {
        id: 'seed',
        type: 'capital',
        amount: STARTING_CAPITAL,
        description: 'Founding seed capital',
        ventureId: null,
        createdAt: new Date(0).toISOString(),
      },
    ],
  });
}

function signedAmount(tx) {
  return tx.type === 'investment' || tx.type === 'expense' ? -Math.abs(tx.amount) : Math.abs(tx.amount);
}

export function getLedger() {
  const { transactions } = load();
  const balance = transactions.reduce((sum, tx) => sum + signedAmount(tx), 0);
  return { balance, startingCapital: STARTING_CAPITAL, transactions };
}

export function getBalance() {
  return getLedger().balance;
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

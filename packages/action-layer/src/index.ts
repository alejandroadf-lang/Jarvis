// The gate every irreversible agent action passes through.
//
// One rule: if it spends money, ships code, or reaches a human being, it goes
// through perform(). Everything else in this package exists to make that one
// call safe to rely on.

export { createActionGate } from './gate.js';
export type { ActionGate, GateOptions, PerformResult } from './gate.js';
export { createMemoryStore } from './stores/memory.js';
export { createPostgresStore } from './stores/postgres.js';
export type { QueryablePool } from './stores/postgres.js';
export { ActionDenied } from './types.js';
export type {
  ActionRequest,
  ActionScope,
  ActionStore,
  AuditEntry,
  SpendWindow,
} from './types.js';

import type { ActionScope, ActionStore, AuditEntry } from '../types.js';

// For tests, and for running the gate before a database exists. Same semantics
// as the Postgres store — the gate's behaviour is tested against this and must
// not differ when it meets a real database.
export function createMemoryStore(): ActionStore {
  const scopes = new Map<string, ActionScope>();
  const entries: AuditEntry[] = [];
  let halt: { halted: boolean; reason?: string } = { halted: false };
  const spendByDay = new Map<string, number>();

  const key = (ventureId: string, action: string) => ventureId + '::' + action;
  const today = () => new Date().toISOString().slice(0, 10);

  return {
    async getScope(ventureId, action) {
      return scopes.get(key(ventureId, action)) ?? null;
    },
    async putScope(scope) {
      scopes.set(key(scope.ventureId, scope.action), { ...scope });
    },
    async getHalt() {
      return { ...halt };
    },
    async setHalt(halted, reason) {
      halt = halted ? { halted, reason } : { halted: false };
    },
    async countAllowedSince(ventureId, action, since) {
      return entries.filter(
        (e) =>
          e.ventureId === ventureId &&
          e.action === action &&
          e.outcome === 'allowed' &&
          e.at >= since
      ).length;
    },
    async lastAllowedAt(ventureId, action) {
      const matches = entries.filter(
        (e) => e.ventureId === ventureId && e.action === action && e.outcome === 'allowed'
      );
      if (!matches.length) return null;
      return matches.reduce((a, b) => (a.at > b.at ? a : b)).at;
    },
    async getSpendToday() {
      return spendByDay.get(today()) ?? 0;
    },
    async addSpend(usd) {
      spendByDay.set(today(), (spendByDay.get(today()) ?? 0) + usd);
    },
    async append(entry) {
      // Append-only in the same sense as the table: nothing here rewrites or
      // removes an entry, so the array only ever grows.
      entries.push({ ...entry });
    },
    async recent(limit, ventureId) {
      return entries
        .filter((e) => !ventureId || e.ventureId === ventureId)
        .slice(-limit)
        .reverse();
    },
  };
}

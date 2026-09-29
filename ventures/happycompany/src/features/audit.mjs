// The audit trail: what changed in the app's configuration and when.
//
// ISO 45001 7.5 (documented information) and every national psychosocial
// risk rule ask the same question of an assessment: who decided what, and
// when. So settings changes, signal switches, committed and closed actions,
// freeze weeks, evidence packs and attestations are logged here.
//
// Team actions are logged without a person. Administrative changes carry the
// administrator's pseudonym, never an account id: an auditor can see that
// the same administrator changed two settings, and the customer's own admin
// can resolve it, but the log itself names nobody. Entries are kept for
// AUDIT_RETAIN_DAYS, the length of an ISO certification cycle.

export const AUDIT_RETAIN_DAYS = 3 * 366;

export function createAudit({ store, now }) {
  let seq = 0;
  async function log(scope, event, detail = {}, by = null) {
    const at = now().toISOString();
    seq = (seq + 1) % 1000;
    const key = `audit:${scope}:${at}:${String(seq).padStart(3, '0')}`;
    await store.set(key, { at, scope, event, detail, by });
    return key;
  }
  async function entries(scope, { since = '', limit = 500 } = {}) {
    const rows = await store.list(`audit:${scope}:`);
    return rows
      .map((r) => r.value)
      .filter((v) => v && v.at >= since)
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .slice(-limit);
  }
  return { log, entries };
}

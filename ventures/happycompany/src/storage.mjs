// The storage this app needs, as three verbs plus a prefix listing.
//
// Forge's key-value store is the only storage a "Runs on Atlassian" app may
// use. Wrapping it does two things: it lets the whole app run against an
// in-memory store in tests, and it hides the cursor loop that a prefix listing
// needs (a query returns at most a page at a time).
//
// Keys, so the prefixes never collide:
//   day:{scope}:{YYYY-MM-DD}  one day of counted activity (has per-person counts)
//   wk:{scope}:{YYYY-Www}     one completed week's metrics (no per-person data)
//   wip:{scope}:{YYYY-MM-DD}  one open-work snapshot (Jira)
//   settings:{scope}          quiet hours, weekend days, time zone
//   tz:{pseudonym}            a cached time zone
//   scopes                    the list of scopes with any data, for the rollup
//   evidence:{product}:{YYYY-Qn}  a closed quarter's evidence pack
//   attest:{product}:{YYYY-Qn}    a signed attestation of that quarter's level
//   attestation:publicKey     the installation's attestation public key
//   backfill:{scope}          progress of the Jira history backfill
//   qscores:{product}:{YYYY-Qn}   per-team mean score and D/E weeks of a closed quarter
//   outcomes:{product}:{YYYY-Qn}  imported team absence rates and leavers
//   secret "salt"             the installation's pseudonym key
//   secret "attestationKey"   the attestation private key

export function forgeStore(kvs, WhereConditions) {
  return {
    get: (key) => kvs.get(key),
    set: (key, value) => kvs.set(key, value),
    delete: (key) => kvs.delete(key),
    async list(prefix) {
      const out = [];
      let cursor;
      do {
        let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
        if (cursor) query = query.cursor(cursor);
        const page = await query.getMany();
        out.push(...(page.results || []));
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
    getSecret: (key) => kvs.getSecret(key),
    setSecret: (key, value) => kvs.setSecret(key, value),
  };
}

export function memoryStore() {
  const data = new Map();
  const secrets = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    data,
    async get(key) {
      return clone(data.get(key));
    },
    async set(key, value) {
      data.set(key, clone(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix) {
      return [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => ({ key, value: clone(value) }));
    },
    async getSecret(key) {
      return secrets.get(key);
    },
    async setSecret(key, value) {
      secrets.set(key, value);
    },
  };
}

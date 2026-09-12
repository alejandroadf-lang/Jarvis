import type { ActionScope, ActionStore, AuditEntry } from '../types.js';

// Postgres-backed, against the tables in schema.sql.
//
// Typed structurally against `pg` rather than importing it, so this package
// carries no hard dependency on a driver: the caller hands in their own pool.
// That is also what lets it run inside a serverless function, where the pool
// is shared across invocations rather than created per call.

export interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export function createPostgresStore(pool: QueryablePool): ActionStore {
  return {
    async getScope(ventureId, action) {
      const { rows } = await pool.query(
        `select venture_id, action, enabled, allowed_targets, max_per_day, max_per_week, cooldown_ms
           from action_scopes where venture_id = $1 and action = $2`,
        [ventureId, action]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        ventureId: row.venture_id,
        action: row.action,
        enabled: row.enabled,
        // null means "no allowlist for this action"; an empty array means
        // "nothing is allowed". Collapsing the two would quietly open a scope.
        allowedTargets: row.allowed_targets === null ? undefined : row.allowed_targets,
        maxPerDay: row.max_per_day ?? undefined,
        maxPerWeek: row.max_per_week ?? undefined,
        cooldownMs: row.cooldown_ms ?? undefined,
      };
    },

    async putScope(scope: ActionScope) {
      await pool.query(
        `insert into action_scopes
           (venture_id, action, enabled, allowed_targets, max_per_day, max_per_week, cooldown_ms)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (venture_id, action) do update set
           enabled = excluded.enabled,
           allowed_targets = excluded.allowed_targets,
           max_per_day = excluded.max_per_day,
           max_per_week = excluded.max_per_week,
           cooldown_ms = excluded.cooldown_ms`,
        [
          scope.ventureId,
          scope.action,
          scope.enabled,
          scope.allowedTargets ?? null,
          scope.maxPerDay ?? null,
          scope.maxPerWeek ?? null,
          scope.cooldownMs ?? null,
        ]
      );
    },

    async getHalt() {
      const { rows } = await pool.query(`select halted, reason from action_halt where id = true`);
      const row = rows[0];
      if (!row) return { halted: false };
      return { halted: row.halted, reason: row.reason ?? undefined };
    },

    async setHalt(halted, reason) {
      await pool.query(
        `insert into action_halt (id, halted, reason, changed_at)
         values (true, $1, $2, now())
         on conflict (id) do update set
           halted = excluded.halted, reason = excluded.reason, changed_at = now()`,
        [halted, reason ?? null]
      );
    },

    async countAllowedSince(ventureId, action, since) {
      const { rows } = await pool.query(
        `select count(*)::int as n from action_log
          where venture_id = $1 and action = $2 and outcome = 'allowed' and at >= $3`,
        [ventureId, action, since]
      );
      return rows[0]?.n ?? 0;
    },

    async lastAllowedAt(ventureId, action) {
      const { rows } = await pool.query(
        `select max(at) as last from action_log
          where venture_id = $1 and action = $2 and outcome = 'allowed'`,
        [ventureId, action]
      );
      return rows[0]?.last ? new Date(rows[0].last) : null;
    },

    async getSpendToday() {
      // Summed from the log rather than kept as a running total. A counter can
      // drift from the record it is meant to summarise, and then the cap is
      // enforcing a number nobody can reconstruct from the evidence.
      const { rows } = await pool.query(
        `select coalesce(sum(cost_usd), 0)::float8 as total from action_log
          where outcome = 'allowed' and at >= date_trunc('day', now())`
      );
      return rows[0]?.total ?? 0;
    },

    async addSpend() {
      // Deliberately empty: cost is written with the log entry and summed by
      // getSpendToday. Present only because the memory store needs it.
    },

    async append(entry: AuditEntry) {
      await pool.query(
        `insert into action_log
           (at, venture_id, agent_id, action, target, outcome, reason, rationale, cost_usd, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          entry.at,
          entry.ventureId,
          entry.agentId,
          entry.action,
          entry.target ?? null,
          entry.outcome,
          entry.reason ?? null,
          entry.rationale ?? null,
          entry.costUsd ?? null,
          entry.detail ? JSON.stringify(entry.detail) : null,
        ]
      );
    },

    async recent(limit, ventureId) {
      const { rows } = await pool.query(
        `select id, at, venture_id, agent_id, action, target, outcome, reason, rationale, cost_usd, detail
           from action_log
          where ($2::text is null or venture_id = $2)
          order by at desc
          limit $1`,
        [limit, ventureId ?? null]
      );
      return rows.map((row) => ({
        id: String(row.id),
        at: new Date(row.at),
        ventureId: row.venture_id,
        agentId: row.agent_id,
        action: row.action,
        target: row.target ?? undefined,
        outcome: row.outcome,
        reason: row.reason ?? undefined,
        rationale: row.rationale ?? undefined,
        costUsd: row.cost_usd ?? undefined,
        detail: row.detail ?? undefined,
      }));
    },
  };
}

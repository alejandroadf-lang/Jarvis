import { ActionDenied } from './types.js';
import type { ActionRequest, ActionStore, AuditEntry, SpendWindow } from './types.js';

// The single chokepoint. Every irreversible thing an agent does goes through
// perform(), and perform() is the only exported way to do one.
//
// The shape is deliberate: you hand it the work as a callback rather than
// asking it for permission and then acting. Ask-then-act has a gap between
// the two where the recording can be forgotten, and an audit trail with holes
// in it is worse than none — it reads as complete.
//
// Order matters and is not arbitrary. Cheapest and most absolute first:
//
//   1. Global halt — the founder's stop button, and nothing gets past it.
//   2. Scope exists and is enabled — off by default, per venture.
//   3. Target allowlist — an empty list permits nothing, never everything.
//   4. Cooldown — catches a loop firing the same action repeatedly.
//   5. Rate caps — per day and per week.
//   6. Spend cap — last, because it is the only check that needs a sum.
//
// Every refusal is written to the audit log before it is thrown. A denial is
// evidence: it is how you find out an agent has been trying something for a
// week.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface GateOptions {
  store: ActionStore;
  /** Ceiling on spend per calendar day across every venture. */
  dailySpendCapUsd?: number;
  /** Called after each entry is written. For alerting the founder on a denial. */
  onEntry?: (entry: AuditEntry) => void;
}

export interface PerformResult<T> {
  result: T;
  entry: AuditEntry;
}

export function createActionGate({ store, dailySpendCapUsd = 0, onEntry }: GateOptions) {
  async function write(entry: AuditEntry): Promise<AuditEntry> {
    await store.append(entry);
    // A listener must never be able to stop the action or corrupt the log.
    try {
      onEntry?.(entry);
    } catch {
      /* ignore */
    }
    return entry;
  }

  async function deny(request: ActionRequest, code: string, message: string): Promise<never> {
    await write({
      at: new Date(),
      ventureId: request.ventureId,
      agentId: request.agentId,
      action: request.action,
      target: request.target,
      outcome: 'denied',
      reason: message,
      rationale: request.rationale,
    });
    throw new ActionDenied(code, message, request);
  }

  async function check(request: ActionRequest): Promise<void> {
    const halt = await store.getHalt();
    if (halt.halted) {
      await deny(
        request,
        'halted',
        halt.reason
          ? `All real actions are halted: ${halt.reason}`
          : 'All real actions are halted.'
      );
    }

    const scope = await store.getScope(request.ventureId, request.action);
    if (!scope) {
      await deny(
        request,
        'no_scope',
        `No scope has been granted for "${request.action}" on this venture.`
      );
    }
    if (!scope!.enabled) {
      await deny(request, 'disabled', `"${request.action}" is switched off for this venture.`);
    }

    // An allowlist that is present and empty permits nothing. Reading it as
    // "unrestricted" is the classic way a scope system quietly opens up.
    if (scope!.allowedTargets !== undefined) {
      const target = request.target ?? '';
      if (!scope!.allowedTargets.includes(target)) {
        await deny(
          request,
          'target_not_allowed',
          `"${target || '(none given)'}" is not on the allowlist for ${request.action}.`
        );
      }
    }

    if (scope!.cooldownMs) {
      const last = await store.lastAllowedAt(request.ventureId, request.action);
      if (last && Date.now() - last.getTime() < scope!.cooldownMs) {
        const waitS = Math.ceil((scope!.cooldownMs - (Date.now() - last.getTime())) / 1000);
        await deny(
          request,
          'cooldown',
          `Too soon after the last ${request.action} — ${waitS}s left on the cooldown.`
        );
      }
    }

    if (scope!.maxPerDay !== undefined) {
      const used = await store.countAllowedSince(
        request.ventureId,
        request.action,
        new Date(Date.now() - DAY_MS)
      );
      if (used >= scope!.maxPerDay) {
        await deny(
          request,
          'daily_cap',
          `Daily cap reached for ${request.action} (${used}/${scope!.maxPerDay} in the last 24h).`
        );
      }
    }

    if (scope!.maxPerWeek !== undefined) {
      const used = await store.countAllowedSince(
        request.ventureId,
        request.action,
        new Date(Date.now() - WEEK_MS)
      );
      if (used >= scope!.maxPerWeek) {
        await deny(
          request,
          'weekly_cap',
          `Weekly cap reached for ${request.action} (${used}/${scope!.maxPerWeek} in the last 7 days).`
        );
      }
    }

    if (dailySpendCapUsd > 0 && request.costUsd) {
      const spent = await store.getSpendToday();
      if (spent + request.costUsd > dailySpendCapUsd) {
        await deny(
          request,
          'spend_cap',
          `Daily spend cap reached — $${spent.toFixed(2)} of $${dailySpendCapUsd.toFixed(2)} used, and this would add $${request.costUsd.toFixed(2)}.`
        );
      }
    }
  }

  return {
    /**
     * Runs `work` only if the request passes every check, and records what
     * happened either way.
     *
     * Throws ActionDenied if refused, or whatever `work` threw if it failed.
     * A failure is logged as 'failed' rather than 'allowed', which keeps the
     * rate caps honest: a send that errored did not consume the quota.
     */
    async perform<T>(request: ActionRequest, work: () => Promise<T>): Promise<PerformResult<T>> {
      await check(request);

      let result: T;
      try {
        result = await work();
      } catch (err) {
        await write({
          at: new Date(),
          ventureId: request.ventureId,
          agentId: request.agentId,
          action: request.action,
          target: request.target,
          outcome: 'failed',
          reason: err instanceof Error ? err.message : String(err),
          rationale: request.rationale,
          costUsd: request.costUsd,
        });
        throw err;
      }

      // Spend is recorded only once the action actually happened, so a refused
      // or failed attempt never eats the budget.
      if (request.costUsd) await store.addSpend(request.costUsd);

      const entry = await write({
        at: new Date(),
        ventureId: request.ventureId,
        agentId: request.agentId,
        action: request.action,
        target: request.target,
        outcome: 'allowed',
        rationale: request.rationale,
        costUsd: request.costUsd,
        detail: isPlainObject(result) ? (result as Record<string, unknown>) : undefined,
      });

      return { result, entry };
    },

    /**
     * Would this be allowed? For showing an agent what it can do before it
     * tries, and for tests. Never a substitute for perform(): the answer can
     * be stale by the time anyone acts on it, which is exactly why the real
     * check lives inside perform() and not in front of it.
     */
    async wouldAllow(request: ActionRequest): Promise<{ allowed: boolean; reason?: string }> {
      try {
        await check(request);
        return { allowed: true };
      } catch (err) {
        if (err instanceof ActionDenied) return { allowed: false, reason: err.message };
        throw err;
      }
    },

    async spendToday(): Promise<SpendWindow> {
      return { spentUsd: await store.getSpendToday(), capUsd: dailySpendCapUsd };
    },

    async halt(reason: string): Promise<void> {
      await store.setHalt(true, reason);
    },

    async resume(): Promise<void> {
      await store.setHalt(false);
    },

    async recent(limit = 50, ventureId?: string): Promise<AuditEntry[]> {
      return store.recent(limit, ventureId);
    },
  };
}

export type ActionGate = ReturnType<typeof createActionGate>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

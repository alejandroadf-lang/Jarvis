// The vocabulary the whole package shares.
//
// One idea runs through all of it: an agent may *ask* to do something, and
// only this layer decides whether it happens. Nothing here is advice to a
// model — an agent that ignores its instructions still cannot get past a
// function that refuses to return.

/** Something with real-world consequences: money moved, code shipped, a stranger emailed. */
export interface ActionRequest {
  /** Which venture this is on behalf of. Scopes are granted per venture, never globally. */
  ventureId: string;
  /** Which agent asked. Recorded by the caller, never self-reported by the model. */
  agentId: string;
  /** The kind of action, e.g. 'send_email', 'deploy_code', 'charge_card'. */
  action: string;
  /**
   * What it acts on — a recipient address, a file path, a repo. Checked against
   * the venture's allowlist for this action when one is set.
   */
  target?: string;
  /** What it will cost, if anything. Counted against the daily spend cap. */
  costUsd?: number;
  /** Why the agent believes this is the right thing. Stored for the audit trail. */
  rationale?: string;
}

/** What the founder has allowed for one action kind on one venture. */
export interface ActionScope {
  ventureId: string;
  action: string;
  /**
   * Off by default. A scope that exists but is disabled refuses, which is what
   * makes "switch it off" instant and total.
   */
  enabled: boolean;
  /**
   * Exact targets permitted. An empty array means nothing is permitted — never
   * "everything". Omit the field entirely for actions that have no target.
   */
  allowedTargets?: string[];
  maxPerDay?: number;
  maxPerWeek?: number;
  /** Minimum gap between two actions of this kind, in milliseconds. */
  cooldownMs?: number;
}

/** One entry in the append-only record. Written whether the action succeeded or not. */
export interface AuditEntry {
  id?: string;
  at: Date;
  ventureId: string;
  agentId: string;
  action: string;
  target?: string;
  /**
   * allowed: the gate permitted it. denied: the gate refused, and `reason`
   * says why. failed: the gate permitted it and the action itself threw.
   */
  outcome: 'allowed' | 'denied' | 'failed';
  reason?: string;
  rationale?: string;
  costUsd?: number;
  /** Anything the caller wants kept — a commit sha, a message id. */
  detail?: Record<string, unknown>;
}

export interface SpendWindow {
  spentUsd: number;
  capUsd: number;
}

/**
 * Everything the gate needs to persist. Implemented against Postgres for real
 * use and in memory for tests, so the policy logic is exercised without a
 * database and behaves identically against one.
 */
export interface ActionStore {
  getScope(ventureId: string, action: string): Promise<ActionScope | null>;
  putScope(scope: ActionScope): Promise<void>;

  /** Whether all real actions are globally halted, and why. */
  getHalt(): Promise<{ halted: boolean; reason?: string }>;
  setHalt(halted: boolean, reason?: string): Promise<void>;

  /** Allowed actions of this kind on this venture since `since`. */
  countAllowedSince(ventureId: string, action: string, since: Date): Promise<number>;
  /** When this venture last performed an allowed action of this kind. */
  lastAllowedAt(ventureId: string, action: string): Promise<Date | null>;

  getSpendToday(): Promise<number>;
  addSpend(usd: number): Promise<void>;

  append(entry: AuditEntry): Promise<void>;
  /** Newest first. For showing the founder what has actually happened. */
  recent(limit: number, ventureId?: string): Promise<AuditEntry[]>;
}

/** Thrown when the gate refuses. Carries a reason fit to show a person. */
export class ActionDenied extends Error {
  readonly code: string;
  readonly request: ActionRequest;

  constructor(code: string, message: string, request: ActionRequest) {
    super(message);
    this.name = 'ActionDenied';
    this.code = code;
    this.request = request;
  }
}

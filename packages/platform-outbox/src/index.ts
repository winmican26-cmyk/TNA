import { randomUUID } from 'node:crypto';

/**
 * Transactional outbox (sections 33-41). Volume 5 documented the fragility of unsynchronized dual
 * writes to Ledger; this package is Volume 8's fix: when platform state changes and Ledger evidence
 * is required, the SAME local transaction that commits the state change also persists an outbox
 * record (durable-store responsibility, owned by `platform-core`, not this package). A separate
 * dispatcher then delivers each pending record to Ledger, so "platform state committed but Ledger
 * temporarily unavailable" never silently loses evidence — the obligation to deliver survives a
 * process restart.
 *
 * Distributed-evidence closure pass (section 1): claiming a record for delivery is a durable,
 * database-level ownership **lease**, not an in-process mutex or a status flag alone. Two
 * independently live processes sharing the same durable store must never both believe they own the
 * same delivery obligation at the same time — see `OutboxPort.claimNext`.
 *
 * This package is intentionally storage-agnostic: it defines the record shape, the pure
 * backoff/dead-letter policy, and a dispatcher that drives an injected `OutboxPort` (the durable
 * claim/mark operations) plus an injected `deliver` function (the actual Ledger write). This mirrors
 * how `auditor-risk` is pure logic consumed by `auditor-engine`'s I/O — no direct SQLite access here.
 */

export const OUTBOX_STATUSES = ['PENDING', 'DELIVERING', 'DELIVERED', 'FAILED', 'DEAD_LETTER'] as const;
export type OutboxStatus = typeof OUTBOX_STATUSES[number];

export interface OutboxRecord {
  readonly outbox_id: string;
  readonly tenant_id: string;
  readonly platform_action_id: string;
  readonly event_type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string;
  readonly status: OutboxStatus;
  readonly ledger_event_id: string | null;
  readonly last_error: string | null;
  /** The durable delivery-ownership lease (section 1). `claim_owner`/`claim_token` are populated only
   * while `status === 'DELIVERING'` (or as the historical trace of whoever last held it); a lease past
   * `claim_expires_at` is treated as abandoned and reclaimable by any dispatcher, never as still owned. */
  readonly claim_owner: string | null;
  readonly claim_token: string | null;
  readonly claim_expires_at: string | null;
}

/** The stable Ledger `event_id` for one outbox record — always derived the same way, so a retried
 * delivery (same outbox_id, same payload) is a Ledger-side no-op rather than duplicate evidence
 * (section 37; Ledger's own `append()` is idempotent per `(tenant_id, event_id)` with identical
 * content — see `ledger-store`). Never regenerated per attempt. This is the second, independent
 * safety layer alongside the ownership lease (section 2): DB ownership lease + stable Ledger event ID
 * — not merely a stable event id on its own — because the two protect different failure modes (lease:
 * "only one process attempts delivery at a time"; idempotent id: "a retried attempt, by the same or a
 * different process, never produces a second logical event"). */
export function outboxLedgerEventId(outboxId: string): string { return `evt_outbox_${outboxId}`; }

export function newOutboxRecord(input: {
  outboxId: string; tenantId: string; platformActionId: string; eventType: string;
  payload: Readonly<Record<string, unknown>>; now: string;
}): OutboxRecord {
  return {
    outbox_id: input.outboxId, tenant_id: input.tenantId, platform_action_id: input.platformActionId,
    event_type: input.eventType, payload: input.payload, created_at: input.now, attempt_count: 0,
    next_attempt_at: input.now, status: 'PENDING', ledger_event_id: outboxLedgerEventId(input.outboxId), last_error: null,
    claim_owner: null, claim_token: null, claim_expires_at: null,
  };
}

/** Bounded exponential backoff (capped): 1s, 2s, 4s, 8s, ... capped at 60s. Deterministic — no
 * jitter — so retry timing is reproducible in tests. */
export function computeBackoffMs(attemptCount: number): number {
  const capped = Math.min(Math.max(0, attemptCount - 1), 6);
  return Math.min(1000 * 2 ** capped, 60_000);
}

export function isDeadLetter(attemptCount: number, maxAttempts: number): boolean { return attemptCount >= maxAttempts; }

/**
 * Durable storage port `platform-core` implements against its own SQLite transaction.
 *
 * `claimNext` must atomically move one eligible record (`PENDING`; `FAILED` with `next_attempt_at <=
 * now`; or `DELIVERING` whose lease has expired, `claim_expires_at <= now`) to `DELIVERING`, stamping
 * a **fresh** `claim_owner`/`claim_token`/`claim_expires_at`, and return it. The conditional UPDATE
 * this performs must be guarded by the exact prior `status` *and* prior `claim_token` it just read —
 * this is the compare-and-swap that makes two independently live processes sharing the same database
 * safe (section 1, 5): only the caller whose read matches the row's current, unchanged state can win
 * the claim; a second caller racing the same expired lease loses and must re-read.
 *
 * `markDelivered`/`markRetry`/`markDeadLetter` must all be conditioned on the caller's own
 * `claim_token` still matching the row's current `claim_token` (a "fencing token") — a claimant whose
 * lease has since been reclaimed by someone else must not be able to overwrite the new owner's work,
 * even if it is only now getting around to reporting its own (possibly stale) outcome. A mismatch is
 * not an error to the caller: by construction it only happens when another owner has already taken
 * authoritative action on the record, so these calls are silent no-ops on a fencing mismatch, never a
 * thrown exception the dispatcher would have to treat as its own failure.
 */
export interface OutboxPort {
  claimNext(now: string, ownerId: string, leaseMs: number): OutboxRecord | null;
  markDelivered(outboxId: string, tenantId: string, claimToken: string, ledgerEventId: string): void;
  markRetry(outboxId: string, tenantId: string, claimToken: string, error: string, nextAttemptAtIso: string): void;
  markDeadLetter(outboxId: string, tenantId: string, claimToken: string, error: string): void;
}

export type OutboxDeliverFn = (record: OutboxRecord) => Promise<{ event_id: string }>;

export interface DispatchSummary { readonly delivered: number; readonly failed: number; readonly deadLettered: number }

/**
 * Drives delivery. `dispatchOnce()` claims and attempts every currently-eligible record once (not a
 * long-running loop — the caller decides polling cadence, e.g. after every state-changing call and
 * on a periodic sweep). Never retries forever: after `maxAttempts` (default 8) a record moves to
 * `DEAD_LETTER` and is never claimed again (section 40).
 *
 * `ownerId` identifies this dispatcher instance for the durable lease (defaults to a fresh random id
 * per dispatcher — pass a stable one explicitly if a process restarts and should be recognizable
 * across restarts, though recognizability is not required for correctness: an expired lease is
 * reclaimable by *any* owner, including a new random id). `leaseMs` bounds how long a claim is
 * honored before another dispatcher may treat it as abandoned (default 30s) — must comfortably exceed
 * the real delivery latency this dispatcher expects, or its own in-flight claims will appear
 * abandoned to a concurrent dispatcher before they finish.
 */
export class OutboxDispatcher {
  private readonly maxAttempts: number;
  private readonly clock: () => number;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  public constructor(private readonly port: OutboxPort, private readonly deliver: OutboxDeliverFn, options: { maxAttempts?: number; clock?: () => number; ownerId?: string; leaseMs?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? 8;
    this.clock = options.clock ?? Date.now;
    this.ownerId = options.ownerId ?? `owner_${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  public async dispatchOnce(): Promise<DispatchSummary> {
    let delivered = 0, failed = 0, deadLettered = 0;
    for (;;) {
      const now = new Date(this.clock()).toISOString();
      const record = this.port.claimNext(now, this.ownerId, this.leaseMs);
      if (!record) break;
      const claimToken = record.claim_token;
      if (!claimToken) throw new Error('claimNext returned a record with no claim_token — port implementation is broken');
      try {
        const result = await this.deliver(record);
        const expectedEventId = outboxLedgerEventId(record.outbox_id);
        if (result.event_id !== expectedEventId) {
          throw new Error(`Outbox delivery must use deterministic ledger event id ${expectedEventId}`);
        }
        this.port.markDelivered(record.outbox_id, record.tenant_id, claimToken, result.event_id);
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown delivery error';
        // claimNext increments attempt_count as part of its durable CAS claim. It therefore already
        // represents the failed invocation here: the first failure is 1 and retries after one second.
        const failedAttemptCount = record.attempt_count;
        if (isDeadLetter(failedAttemptCount, this.maxAttempts)) {
          this.port.markDeadLetter(record.outbox_id, record.tenant_id, claimToken, message);
          deadLettered += 1;
        } else {
          const nextAttemptAt = new Date(this.clock() + computeBackoffMs(failedAttemptCount)).toISOString();
          this.port.markRetry(record.outbox_id, record.tenant_id, claimToken, message, nextAttemptAt);
          failed += 1;
        }
      }
    }
    return { delivered, failed, deadLettered };
  }
}

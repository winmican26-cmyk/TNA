# TNA Platform Transactional Outbox v0.1

## Why (sections 33-34, TNA-46)

Volume 5 documented the fragility of unsynchronized dual writes to Ledger. When platform state
changes and Ledger evidence is required, the **same local SQLite transaction** that commits the state
change also inserts an outbox record (`PlatformStore.enqueue`, called from inside every state-changing
method's own transaction). A separate dispatcher then delivers pending records to Ledger. "Platform
state committed but Ledger temporarily unavailable" therefore never silently loses evidence — the
obligation to deliver survives a process restart.

## Package boundary

`packages/platform-outbox` is storage-agnostic: `OutboxRecord`, the pure backoff/dead-letter policy
(`computeBackoffMs`, `isDeadLetter`), and `OutboxDispatcher` (drives an injected `OutboxPort` plus an
injected `deliver` function). `platform-core`'s `PlatformStore` implements `OutboxPort` against its
own SQLite table; `PlatformLedgerDispatcher` wires the real Ledger `append()` call as the `deliver`
function. This mirrors how `auditor-risk` is pure logic consumed by `auditor-engine`'s I/O.

## States

`PENDING -> DELIVERING -> DELIVERED`, or `PENDING/FAILED (retry) -> DEAD_LETTER` after
`maxAttempts` (default 8).

## Delivery idempotency (section 37)

`outboxLedgerEventId(outboxId) = 'evt_outbox_' + outboxId` — always derived the same way, never
regenerated per attempt. Ledger's own `append()` is idempotent per `(tenant_id, event_id)`: the same
`event_id` with identical content is a no-op returning the existing row; different content is
`EVENT_CONFLICT`. Since an outbox record's payload never changes across retries, a retried delivery is
always a safe Ledger-side no-op, not duplicate evidence. `OutboxDispatcher` additionally verifies the
`deliver` function actually returned the expected deterministic id before marking delivered — a
`deliver` implementation that returned something else is treated as a failure, not silently accepted
(proven in `platform-outbox.test.ts`).

## CAS claim (section 97)

`PlatformStore.claimNext(now)` atomically moves one eligible record (`PENDING`, or `FAILED` with
`next_attempt_at <= now`) to `DELIVERING` inside its own transaction and returns it — this is what
makes two concurrent dispatchers safe: only one can win the claim for any given record. Proven
directly with two `OutboxDispatcher`s racing the same record concurrently
(`platform-races.test.ts`) — exactly one delivery.

## Dead letter (section 40)

Bounded, not infinite: after `maxAttempts`, a record moves to `DEAD_LETTER` and is never claimed
again. `PlatformStore.evidenceStatus()` reports `DEGRADED` for an action with any `DEAD_LETTER` outbox
record — the real execution result is never erased to make evidence delivery look clean (section 41,
TNA-47): `execution result: SUCCEEDED` and `evidence delivery: DEGRADED` are reported as the two
separate facts they are.

## Restart recovery (sections 38-39)

A record left `DELIVERING` at process-restart time (a crash mid-Ledger-write, outcome unknown) is
swept to `FAILED` with its deterministic `ledger_event_id` preserved — the next dispatch attempt is
therefore a safe retry, never a duplicate. Proven directly: create an action, claim its outbox record
without delivering, close the store, reopen it, and observe the record `FAILED` and re-claimable
(`platform-outbox.test.ts`). Demo Flow 5 exercises the same recovery against a genuinely simulated
Ledger outage followed by a real process-level store close/reopen.

# TNA Platform Integration v0.1 — Final Distributed-Evidence Closure Pass

## Origin

The original Volume 8 submission reached 579/579 passing tests and all six demo flows green, and
recorded two residual limitations honestly rather than silently:

- **V8-A1**: outbox delivery claims used single-process SQLite CAS, but were never proven against two
  independently live processes sharing the same database file — the existing "concurrent outbox
  dispatch" test raced two `OutboxDispatcher`s against one **shared, in-process** fake port, which
  proves the dispatcher's own claim-conflict handling but does not prove multi-process safety.
- **V8-A2**: `PlatformLedgerDispatcher.toLedgerEvent()` derived `causation_id` and
  `authority_context.decision_id`/`policy_hash` from the action's *current* `gate_decision` at dispatch
  time, for every record type, rather than from what was true when each record's obligation was
  actually created.

This document is the closure of both findings, per the same "do not pretend it never existed"
discipline every prior closure pass in this project has followed (Sentinel's concurrency closure,
Auditor's trust closure). It does not add platform features, does not extend MCP, does not touch
frontend/cloud/billing/IAM, and does not declare `tna-platform-v0.1` accepted or tag it.

---

## Finding 1 — multi-process outbox ownership

### Original behavior

`PlatformStore.claimNext(now)` moved one eligible `PENDING`/`FAILED` record to `DELIVERING` via a
single conditional `UPDATE ... WHERE status=?`, with no lease, no owner identity, and no expiry. This
is a correct compare-and-swap *within one process's own use of it*, but nothing distinguished "this
record is actively being delivered by a live process right now" from "this record is stuck DELIVERING
because whoever claimed it crashed." `recoverInterruptedWork()` (run on every `PlatformStore`
construction) unconditionally swept *every* `DELIVERING` record to `FAILED` — correct for a single
restarting process recovering its own crash, but wrong the instant a second, independently live
`PlatformStore` process shares the same file: a fresh instance's own startup sweep would forcibly
un-claim a record a *different, still-running* process was legitimately, actively delivering.

### Risk

Two platform processes (a real horizontally-scaled deployment, or simply a restart racing a still-live
older instance during a rolling deploy) sharing one SQLite database could both believe they owned the
same delivery obligation, or one could silently steal a live delivery in progress from the other.

### Fix — durable database-level lease

`OutboxRecord` gained `claim_owner`, `claim_token`, `claim_expires_at`. `claimNext(now, ownerId,
leaseMs)` now:

1. Selects one eligible record: `PENDING`; `FAILED` past its backoff; or `DELIVERING` whose
   `claim_expires_at` has already passed (an abandoned lease).
2. Performs the claim as one conditional `UPDATE ... WHERE status=? AND claim_token IS ?`, guarded by
   the **exact** `status` and `claim_token` just read — a fencing-token compare-and-swap. A second
   process racing the same row reads the same pre-claim snapshot but loses the conditional update,
   because the first winner already changed `claim_token`.
3. Stamps a fresh, unique `claim_token`, the calling process's `ownerId`, and `claim_expires_at = now +
   leaseMs`.

`markDelivered`/`markRetry`/`markDeadLetter` are all now fenced on `claim_token`: `UPDATE ... WHERE
status='DELIVERING' AND claim_token=?`. A caller whose lease has since been reclaimed by a different
owner has its write silently ignored — never an exception, and never able to overwrite whatever the
new authoritative owner has since done.

`recoverInterruptedWork()`'s outbox sweep is now lease-aware: `WHERE status='DELIVERING' AND
(claim_expires_at IS NULL OR claim_expires_at<=?)`. A live, unexpired lease is left strictly alone on
restart — a fresh `PlatformStore` instance no longer assumes it is the only writer.

The guarantee lives entirely in SQLite's own transactional CAS (`BEGIN IMMEDIATE` + the conditional
`UPDATE`'s row-count check), not an in-process mutex — proven by constructing two genuinely separate
`PlatformStore`/`DatabaseSync` connections against the same file (`tests/platform/
platform-distributed-outbox.test.ts`), the identical technique the accepted Sentinel
concurrency-closure pass used for "two separate SentinelRuntime instances sharing one SQLite file."

### Crash semantics proven directly

- **Owner death before delivery**: process A claims, then is closed without ever calling `deliver()`
  or any `mark*` method. After the lease expires, a second, independent `PlatformStore` claims and
  delivers the same record — it is never left permanently stuck `DELIVERING`.
- **Crash after Ledger append, before local acknowledgement** (the mandatory case): process A claims,
  calls the real Ledger `append()` directly (bypassing the dispatcher's own `markDelivered` call
  entirely — the only honest way to simulate a genuine crash between those two steps without actually
  killing a process), and is closed. After the lease expires, a second process retries delivery for the
  *same* outbox record. Because `outboxLedgerEventId()` is deterministic and Ledger's own `append()` is
  idempotent per `(tenant_id, event_id)`, the retry is a safe no-op that returns the *same* event —
  exactly one logical Ledger event exists, and the outbox record ultimately reaches `DELIVERED`.
- **Lease not stealable before expiry**: a second live instance racing an active, unexpired claim gets
  `null` from `claimNext` — it never independently believes it owns the delivery.

### Second layer preserved (section 2)

The deterministic `ledger_event_id` and Ledger's own idempotent `append()` are unchanged and still in
force — the safety model is now **DB ownership lease + stable Ledger event id**, not merely the
latter. The two protect different failure modes: the lease prevents two processes from *attempting*
delivery concurrently in the normal case; the idempotent id makes a *retried* attempt (by the same or a
different process, after a lease expired mid-flight) safe even though the lease alone cannot prevent
that retry from happening.

### Tests

`tests/platform/platform-distributed-outbox.test.ts` (4 new tests): two independently live instances
racing five records to completion with no lost or duplicated evidence; lease-not-stealable-before-expiry;
owner-death lease-expiry recovery; crash-after-append idempotent retry to exactly one logical event.
`tests/platform/platform-races.test.ts`'s existing in-process fake-port test was kept (renamed to make
clear it is a narrower unit test of the dispatcher's own conflict handling, not a substitute for the
new multi-process test) and updated for the new lease-aware `OutboxPort` signature.

### Remaining limitations

- Lease duration (`leaseMs`, default 30s) is a fixed timeout, not adaptive to actual delivery latency —
  a genuinely slow (but not dead) delivery could have its lease expire and be reclaimed by another
  process while still in flight. The fencing-token guard makes this safe (the original claimant's late
  `markDelivered` is a no-op), but it means a slow delivery could in principle be attempted twice
  concurrently for a brief window before the fencing resolves it — still bounded by Ledger idempotency,
  never duplicate evidence, but worth calling out precisely.
- No liveness/heartbeat renewal mechanism for a legitimately long-running delivery attempt — v0.1's
  delivery attempts are expected to be fast (a single Ledger `append()` call); a future milestone adding
  slower delivery targets would need lease renewal, not built here.

---

## Finding 2 — record-specific causation

### Original behavior

`PlatformLedgerDispatcher.toLedgerEvent(record)` re-fetched the action's *current* row
(`store.get(...)`) and set `causation_id: gate.decision_id` and
`authority_context.{decision_id,policy_hash}` from that current `gate_decision` — for **every** record
type, including `PLATFORM_ACTION_RECEIVED` (which predates any decision existing at all).

### Risk

An action's `gate_decision` can genuinely change after being set once — the `HELD -> AUTHORIZING`
resume path calls `Gate.authorize()` again, which always issues a fresh `decision_id` (even for an
identical outcome). A record enqueued *before* that second decision, but dispatched (or retried) after
it, would retroactively acquire the *later* decision as its cause — a real provenance-integrity defect,
not a hypothetical one.

### Fix — causation captured at obligation-creation time

`PlatformStore.enqueue()` now computes `causation_event_id` once, at the exact moment each record is
created, by reading `platform_actions.last_outbox_id` (the immediately preceding record this same
action enqueued) inside the *same* transaction, converting it to its deterministic Ledger identity
(`outboxLedgerEventId`), and writing it into the new record's own `payload`. `last_outbox_id` is then
advanced to the new record. Because a record's `payload` is never rewritten by any other method, this
snapshot is permanent from the instant of creation.

`toLedgerEvent()` no longer reads `action.gate_decision` at all. `causation_id` comes only from
`record.payload.causation_event_id`; `authority_context.decision_id`/`policy_hash` come only from
`record.payload` (a flat `decision_id`/`policy_hash`, or `gate_decision.decision_id`/`.policy_hash` as
`recordGateDecision`'s own enqueue call already shapes it). `action` is still read for fields that are
genuinely immutable for the action's lifetime (`request.*`, `correlation_id`, `input_hash`,
`tenant_id`) — none of which can drift.

Per section 7's instruction not to populate irrelevant fields: `PLATFORM_ACTION_RECEIVED` and the
generic `AUTHORIZING`-transition record carry no domain ids (none exist yet); `PLATFORM_ACTION_
{AUTHORIZED,BLOCKED,HELD}` carries `gate_decision`; `PLATFORM_EXECUTION_CLAIMED` carries `decision_id`,
`capability_id`, `sentinel_session_id` (the exact facts newly relevant at that step); execution-result
and verification-result records carry their own `execution`/`verification` evidence. Each record does
not re-snapshot its entire ancestry — the `causation_event_id` chain provides that transitively.

### Causal model

Each event's `causation_id` is the event immediately preceding it *for that action*, forming one
linear chain per action from `PLATFORM_ACTION_RECEIVED` (root, no cause) through to its terminal event
— matching section 8's diagram exactly, while allowing the platform's deliberately minimal
`PLATFORM_*` event taxonomy (no independent Ledger record for every internal state hop; see
`platform-ledger-integration-v0.1.md`). `reconstructPlatformAction()` gained `causal_chain: readonly
CausalChainStep[]`, each step exposing `event_id`, `event_type`, `caused_by`, and whichever
`decision_id`/`capability_id`/`sentinel_session_id`/`execution_id`/`vad_atom_id` that specific record
captured — so an independent reviewer can walk backwards from, say, a VAD verification step to the
execution it verified to the capability/session/decision that authorized it, entirely from durable,
per-record data, never from the action's current mutable state.

A secondary ordering defect was found and fixed while proving this: `claimNext` and `listOutbox` both
ordered by `created_at` (with `outbox_id`, a random UUID, as an incidental tie-breaker), which does not
guarantee true creation order for records sharing one timestamp (routine under a fast-ticking or mocked
clock — every demo flow and most tests share one mocked instant). Both now order by SQLite's own
implicit `rowid`, which is monotonic in true insertion order — this does not affect correctness of the
causal chain itself (fixed at enqueue time regardless of read/dispatch order) but was required for
`causal_chain`'s own internal consistency to be observable and testable at all.

### Tests

`tests/platform/platform-causation.test.ts` (7 new tests): historical-causation-does-not-drift (the
HELD → resume → second-decision scenario, dispatched only after the second decision exists — proven
against the exact mechanism section 9 describes); BLOCK causal chain (no fabricated capability/
Sentinel/execution ids); ALLOW → capability → Sentinel → execution chain (verified both in the
in-memory reconstruction and in the real delivered Ledger stream's own `causation_id` links); VAD
causal chain (verification step transitively chains back to its execution); termination causal chain
(terminal record chains to the execution claim, with no fabricated execution/VAD outcome); cross-action
splicing (one action's outbox/reconstruction never includes another's records, same tenant);
cross-tenant splicing (a deliberately forced colliding `correlation_id` across two tenants still never
lets one tenant's Ledger query or reconstruction surface the other's events — white-box, since a
genuine collision cannot occur through any real code path given UUID generation).

### Remaining limitations

- The causal chain is per-action and linear (one predecessor per record) — it does not model a record
  with multiple independent causes (not needed for this milestone's event set, where each action's
  lifecycle is strictly sequential).
- The chain is only as complete as what each `enqueue()` call site chose to capture; a future new event
  type must deliberately decide what causal facts are relevant to it, following section 7's discipline,
  not copy every existing field reflexively.

---

## Section 13 — accepted-component adapter review (no broad refactor)

Neither `ExecutionBroker`'s hardcoded `'production.deploy'` operation-binding rule nor its private,
single-tool `ToolInputRegistry` was touched. The platform still integrates by:

- **Operation binding**: `brokerOperation(action)` in `platform-core` exactly mirrors Gate's own
  internal rule (`'write'` for the literal action string `'production.deploy'`, `'read'` otherwise) —
  a read of Gate's real behavior, not a reinterpretation of it. The platform's own `operation` field
  (used for Sentinel's `allowed_operations`) is a materially different, more general concept than this
  narrow binding rule, and the two are kept explicitly separate in the code and in
  `platform-gate-integration-v0.1.md` — the platform does not claim these are the same thing.
- **`input_hash` binding**: enforced independently by the platform itself (`computeInputHash`, checked
  before every `redeem()` call), not delegated to Gate's own capability `input_hash`, which — as
  documented in the original proof-of-work's failing-first defects — is inert (`hash(null)`) for any
  tool other than `demo.deploy.execute`. The platform does not claim Gate's own capability layer
  enforces this binding for its own connectors; it only ever claims that *the platform itself* does,
  which is verifiably true and independently tested.
- **Tool input semantics**: the platform does not translate its own connector's real input into
  `demo.deploy.execute`'s specific schema to obtain a false green test. The demo/test connector's
  handler genuinely receives `{}` from the broker (documented, not hidden), and the platform's own
  persisted `request.input` remains the authoritative record of what was actually requested — visible
  directly in `reconstructPlatformAction()`'s `request` field and in every Ledger event's
  `payload.input_hash`.

No accepted Gate file was modified. This review confirms the original assessment stands: the platform
integrates around these two accepted-component constraints, it does not paper over them.

## Section 14 — Auditor limitation, tested honestly

No new Ledger event types, no re-emission of Gate/Sentinel/VAD-native event types, and no synthetic
evidence were added to make Auditor return `PASS`. `platform-auditor-integration-v0.1.md`'s original
framing stands unchanged: platform orchestration is discoverable and auditable by correlation_id, but
v0.1 does not yet provide sufficient native-component Ledger evidence for every Auditor control, and
that assessment — genuinely computed, never fabricated — correctly reports `INSUFFICIENT_EVIDENCE` for
some controls. This closure pass did not touch that boundary.

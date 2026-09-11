# TNA Platform Integration v0.1 Threat Model

Status per category: MITIGATED, PARTIALLY MITIGATED, or NOT MITIGATED (explicit, by design or by
scope). "Mitigated" means a deterministic control exists and is tested — not that the category is
impossible.

| # | Threat | Status | Detail |
|---|---|---|---|
| 1 | Authorization bypass | MITIGATED | there is no code path from a platform action to `ExecutionBroker.redeem()` that does not first pass through `PlatformGateOrchestrator.authorize()` reaching `AUTHORIZED`; the state machine has no transition from `RECEIVED`/`BLOCKED`/`HELD` into `CAPABILITY_ISSUED` |
| 2 | Direct connector bypass | MITIGATED | connectors are registered only as Gate `ToolRegistry` handlers; `ToolRegistry.invoke()` is broker-only by Gate's own accepted design (`abuse: an agent cannot invoke a connector directly`) — the platform API exposes no other path to a connector |
| 3 | Agent self-approval | MITIGATED | `PlatformControlOrchestrator.resume()`/`terminate()` require `platform-operator`/`platform-admin`; `platform-schema`'s own role guard rejects an agent principal before either method body runs |
| 4 | Agent self-resume of a security hold | MITIGATED | same guard as #3 — a `platform-agent` credential cannot call `/approve` or `/resume` on its own action, proven over real HTTP |
| 5 | Input mutation between authorization and execution | MITIGATED | `input_hash` bound at `RECEIVED`, re-verified before every `redeem()` call; structurally unreachable via the public API, proven by a white-box drift test |
| 6 | Capability replay | MITIGATED | Gate's own accepted `ExecutionBroker` capability is single-use and consumed atomically on first `redeem()`; a second attempt on the same terminal action is rejected at the platform's own CAS layer before the broker is even reached |
| 7 | Sentinel bypass | MITIGATED | the pre-action `TOOL_CALL_REQUESTED` observation is submitted and evaluated before any `redeem()` call; there is no execution path that skips it |
| 8 | Missing runtime observations | PARTIALLY MITIGATED | pre-action and one post-action observation are submitted for every execution; a synchronous, non-isolated connector model means there is no long-running in-flight window to instrument further in v0.1 — documented, not silently assumed complete |
| 9 | Connector impersonation / identity drift | MITIGATED | the platform never submits a connector-reported tool/resource to Sentinel, only the registered, authorized values (structural guarantee); Sentinel's own `TOOL_NOT_ALLOWED` rule independently catches a mismatch if one were ever submitted, proven directly |
| 10 | Cross-tenant connector resolution | MITIGATED | `ConnectorRegistry` is tenant-scoped (`get(tenantId, tool)`); a connector registered for one tenant is not resolvable for another |
| 11 | Cross-tenant action access | MITIGATED | every `PlatformStore` query is `(tenant_id, ...)`-scoped; the HTTP layer additionally denies a `platform-agent` reading another agent's action within the same tenant |
| 12 | Execution double-claim | MITIGATED | `claimExecution` is a CAS-protected, single-winner transition; proven with genuinely concurrent `Promise.allSettled` claims, not sequential calls |
| 13 | Duplicate side effect from retried submission | MITIGATED | `(tenant_id, request_id)` uniqueness makes `createOrReturn` idempotent; a progressed action is never re-executed by a repeat submission |
| 14 | Ledger loss on temporary outage | MITIGATED | transactional outbox — state change and evidence obligation commit in one local transaction; delivery retried with bounded backoff, proven to survive a real process restart |
| 15 | Outbox duplication | MITIGATED | deterministic `event_id` per outbox record plus Ledger's own idempotent `append()`; proven with two dispatchers racing the same record |
| 16 | Outbox poisoning (infinite retry of a permanently-failing record) | MITIGATED | bounded `maxAttempts` before `DEAD_LETTER`; a dead-lettered record is never reclaimed |
| 17 | Evidence/execution-result mismatch reported as clean success | MITIGATED | `evidenceStatus()` reports `DEGRADED` independently of the recorded execution result — the two facts are never merged (TNA-47) |
| 18 | VAD bypass | MITIGATED | `requires_verification: true` with no configured `VadPort` resolves to `INDETERMINATE`, never a silent `COMPLETED` |
| 19 | VAD result forgery | MITIGATED (by construction) | `vad_final_state`/`vad_atom_id` are written only by `PlatformStore.recordVerificationResult`, called only from `PlatformExecutionOrchestrator`'s own `VadPort` result handling — no caller-facing API sets these fields, and `validatePlatformActionRequestInput` explicitly rejects a caller-supplied `vad_result` field outright |
| 20 | Platform status forgery | MITIGATED (by construction) | `status`/`state_version`/`decision_id`/`capability_id`/`sentinel_session_id`/`execution_id`/`result_hash`/`ledger_event_id`/`audit_result`/`evidence_status`/`input_hash`/`created_at`/`created_by` are all rejected outright if present in a caller-supplied request (explicit field list, not a generic strip) |
| 21 | Terminate/complete race | MITIGATED | both are CAS transitions from the same `EXECUTING` version; exactly one wins, proven with genuinely concurrent racers, and the final state is always exactly whichever one actually committed |
| 22 | Hold/execute race | MITIGATED | an execution claim requires the exact `MONITORING`-stage `state_version`; once that version has moved (for any reason, including a hold-equivalent resolution), the claim CAS fails — proven directly |
| 23 | Concurrent outbox dispatch corruption | MITIGATED | `claimNext`'s own CAS claim step, proven with two dispatchers racing one record |
| 24 | Restart data loss | MITIGATED | `EXECUTING` actions recover to `INDETERMINATE`; `DELIVERING` outbox records recover to `FAILED` with their deterministic event id intact — proven against a real reopened SQLite store |
| 25 | Tenant isolation failure | MITIGATED | `(tenant_id, ...)` scoping throughout `PlatformStore`; no query or transition method accepts an unscoped identifier |
| 26 | Connector registry injection | MITIGATED | `ConnectorRegistry.register()` is trusted-startup-only; there is no API surface that accepts a connector definition from a request |
| 27 | Oversized request/result payload | MITIGATED | `MAX_INPUT_BYTES`, `MAX_METADATA_BYTES`, `MAX_BODY_BYTES` enforced at validation/HTTP-body-read time, before storage |
| 28 | SQL injection | MITIGATED (by construction) | every `PlatformStore` query is parameterized (`?` placeholders); no string concatenation into SQL anywhere |
| 29 | Compromised platform process | NOT MITIGATED (by design) | identical posture to every accepted TNA milestone — if the platform process itself is compromised, its own conclusions cannot be trusted |
| 30 | Compromised host / privileged database rewrite | NOT MITIGATED (by design) | identical posture to the accepted Ledger/Auditor milestones — a party with direct SQLite file access can rewrite the platform's own store; this is exactly the scenario Auditor's evidence-integrity qualification (TNA-41) exists to catch *for the evidence Auditor consumes*, proven directly against a platform-orchestrated action in `platform-auditor-integration.test.ts` |
| 31 | Simultaneous multi-process outbox claim | MITIGATED | delivery-ownership lease (`claim_owner`/`claim_token`/`claim_expires_at`) claimed via a fencing-token SQLite CAS `UPDATE`; proven with two genuinely independent `PlatformStore`/`DatabaseSync` connections against one shared file racing five records to completion with no lost or duplicated evidence — `platform-distributed-outbox.test.ts` |
| 32 | Stale delivery owner (expired lease assumed live, or a live lease assumed expired) | MITIGATED | `recoverInterruptedWork()`'s outbox sweep only reclaims `DELIVERING` records whose `claim_expires_at` has actually passed; a live, unexpired lease held by a different process surviving a fresh instance's own startup is proven untouched — `platform-outbox.test.ts` |
| 33 | Dispatcher death while owning a record | MITIGATED | a claim with no subsequent `mark*` call (simulating a killed process) is recoverable by a second, independent instance once its lease expires — never permanently stuck `DELIVERING` — `platform-distributed-outbox.test.ts` |
| 34 | Crash after Ledger append but before local acknowledgement | MITIGATED | deterministic per-record `event_id` plus Ledger's own idempotent `append()`; a real direct-append-then-crash is simulated and the retrying process's re-append is proven to produce exactly one logical Ledger event, not a claim of exactly-once external execution — `platform-distributed-outbox.test.ts` |
| 35 | Outbox lease stealing before expiry | MITIGATED | the fencing-token CAS makes a second process's claim attempt against a live, unexpired lease return nothing; proven directly — `platform-distributed-outbox.test.ts` |
| 36 | Causation drift (a record acquires a causal parent decided after the record was created) | MITIGATED | `causation_event_id` is captured once, at enqueue time, from the action's `last_outbox_id` pointer, and is never recomputed from later state; a HELD action's second, genuinely different Gate decision (via resume) is proven not to retroactively become the earlier queued record's cause — `platform-causation.test.ts` |
| 37 | Causation derived from mutable current state | MITIGATED | `toLedgerEvent()` no longer reads `action.gate_decision` (or any other current mutable field) for causation or `authority_context`; both are sourced only from the dispatched record's own immutable `payload` snapshot — `platform-core/src/index.ts`, proven by every causation test |
| 38 | Cross-action evidence splicing | MITIGATED | `listOutbox`/`causal_chain` are scoped to `(tenant_id, platform_action_id)`; proven that one action's reconstructed chain never includes another action's records within the same tenant — `platform-causation.test.ts` |
| 39 | Cross-tenant causal-chain splicing | MITIGATED | proven even under a deliberately forced colliding `correlation_id` across two tenants (white-box only — not reachable through any real code path): each tenant's Ledger reader and reconstruction surface only its own events, never the other tenant's — `platform-causation.test.ts` |

## Distributed transaction limitation (section 102)

**TNA Platform v0.1 coordinates multiple independently durable components. It does not provide one
ACID transaction across Gate, Sentinel, Ledger, VAD, external connectors, and Auditor.** The
transactional outbox reduces evidence-loss risk between the platform's own state and Ledger. It does
not create global distributed atomicity across all five subsystems — a crash between, say, capability
issuance and Sentinel session creation leaves the action `INDETERMINATE` on restart (section 99), which
is the honest representation of genuine uncertainty, not a claim of an all-or-nothing transaction that
does not exist.

## Connector side-effect limitation (section 103)

**Once an external connector performs a non-idempotent side effect, TNA cannot universally roll it
back.** This is why every uncertain outcome in this milestone (a Sentinel hold/termination whose
containment is unconfirmed, a crash mid-execution, evidence delivery exhausting its retries) resolves
to `INDETERMINATE` rather than a guessed `SUCCEEDED`/`FAILED` — representing uncertainty honestly is
the only correct response when the real-world side effect's outcome cannot be confirmed (TNA-48).

## Exactly-once limitation (section 71)

No claim of exactly-once external effects is made. The platform provides at-most-once capability
redemption (Gate's own single-use guarantee) and idempotency at its own request-submission boundary;
an uncertain external side effect is represented as `INDETERMINATE`, never blindly retried.

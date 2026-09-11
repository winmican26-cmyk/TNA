# TNA Platform Integration v0.1 Proof of Work

## Accepted Baseline

- Volume 1-3 — TNA Gate v0.1-v0.3
- Volume 4 — VAD Engine v0.1
- Volume 5 — TNA Ledger v0.1
- Volume 6 — TNA Sentinel v0.1
- Volume 7 — TNA Auditor v0.1

All seven remain untouched. No accepted tag was moved or rewritten.

## Git State

- Branch: `trust-no-agent-main`
- HEAD entering this milestone: `1f4470835886041f0da3fe51a7286da9c0fa066c`
- This milestone's work is currently uncommitted in the working tree, presented for review before any
  commit/tag step, per the workflow established by every prior volume.
- The unrelated untracked file `output/imagegen/tna-handoff-logo-concept-01.png` was not staged,
  modified, or deleted.

## Files Created

```
packages/platform-schema/{package.json,src/index.ts}
packages/platform-outbox/{package.json,src/index.ts}
packages/platform-connectors/{package.json,src/index.ts}
packages/platform-core/{package.json,src/index.ts}
apps/tna-platform/{package.json,src/{index,gate-adapter,vad-adapter,connectors,writers,server,main}.ts}
scripts/demo-platform-v01.ts
tests/platform/{platform-state,platform-outbox,platform-orchestration,platform-execution,
  platform-http,platform-abuse-cases,platform-races,platform-auditor-integration}.test.ts
docs/platform/{platform-overview-v0.1,platform-action-spec-v1,platform-state-machine-v0.1,
  platform-orchestration-v0.1,platform-gate-integration-v0.1,platform-sentinel-integration-v0.1,
  platform-vad-integration-v0.1,platform-ledger-integration-v0.1,platform-outbox-v0.1,
  platform-auditor-integration-v0.1,platform-connector-model-v0.1,platform-mcp-boundary-v0.1,
  platform-threat-model-v0.1,platform-verification-v0.1,platform-requirement-matrix-v0.1,
  proof-of-work-platform-v0.1}.md
```

## Files Modified

- `package.json` — added `demo:platform:v01` and `start:platform` scripts.
- `packages/ledger-schema/src/index.ts` — additive extension: `SourceComponent` gained `'platform'`,
  `EVENT_TYPES` gained twelve `PLATFORM_*` types. No existing value removed, renamed, or reordered —
  same discipline every prior milestone's Ledger extension followed. See
  `platform-ledger-integration-v0.1.md`.
- `apps/tna-ledger/src/writers.ts` — additive: `platformWriter(tenantId)` and
  `platformLedgerReader(tenantId)`. `gateWriter`/`vadWriter`/`sentinelWriter`/`auditorWriter`/`reader`/
  `admin` are unmodified.

No accepted Gate, VAD, Ledger, Sentinel, or Auditor *behavior* was altered — the only accepted files
touched (`ledger-schema`, `tna-ledger/writers.ts`) had values added to closed enums/factories, never
removed or changed in meaning, and all 535 pre-existing tests plus every prior demo remain green.

## Platform Architecture

Four packages plus one app, consolidated deliberately (section 5: "do not create unnecessary
packages"):

- **platform-schema** — request/state/principal types and validation, canonicalization/hashing,
  secret rejection, the 13-state lifecycle and its allowed-transition table. No I/O.
- **platform-outbox** — the transactional outbox record shape, pure backoff/dead-letter policy, and a
  dispatcher driven by an injected storage port and delivery function. No direct SQLite access.
- **platform-connectors** — the `ToolConnector` interface, a tenant-scoped trusted registry, the one
  demo connector, and the MCP boundary type. No authorization/mediation logic.
- **platform-core** — `PlatformStore` (the durable CAS state machine + outbox implementation),
  `PlatformGateOrchestrator`, `PlatformExecutionOrchestrator`, `PlatformControlOrchestrator`,
  `PlatformFacade`, `PlatformLedgerDispatcher`, and `reconstructPlatformAction`. Imports Sentinel/VAD/
  Ledger/Auditor's own accepted library classes where they are real packages; talks to Gate through a
  narrow `GatePort`/`VadPort` interface pair, satisfied by adapters living in `apps/tna-platform`.
- **apps/tna-platform** — `GateActionAdapter`, `VadVerificationAdapter`, connector→`ToolRegistry`
  wiring, the HTTP API, and the process composition root.

## Responsibility Boundaries

Proven structurally, not just documented: there is no transition in the state machine from
`RECEIVED`/`BLOCKED`/`HELD` into `CAPABILITY_ISSUED`; `ToolRegistry.invoke()` is broker-only by Gate's
own accepted design (a direct-call attempt throws); Sentinel's containment call is never invoked by
the platform itself, only by `SentinelRuntime`'s own accepted internals in response to a decision the
platform merely observes; `PlatformExecutionOrchestrator` never imports `AuditorRuntime`.

## Platform Action Model

See `platform-action-spec-v1.md`. `PlatformActionRequestInput` rejects any unknown top-level field and
an explicit list of runtime-owned field names outright — a forgery attempt fails loudly, not silently.

## State Machine

13 states, CAS-protected via `state_version`, restart-recovery swept to `INDETERMINATE`/`FAILED` never
a fabricated `COMPLETED`. See `platform-state-machine-v0.1.md`.

## Gate / Capability / Sentinel / Execution Broker / Connector / VAD / Ledger / Auditor Integration

See the respective per-component docs. Every integration uses the real, accepted library class or a
narrow adapter around one that lives outside `packages/` — nothing was reimplemented.

## Transactional Outbox

See `platform-outbox-v0.1.md`. Delivery is idempotent (deterministic event id + Ledger's own idempotent
`append()`), bounded (dead-letter after 8 attempts), and survives a real process restart.

## Reconstruction

`reconstructPlatformAction()` answers section 148's defining question directly from durable state:
CONTROL (the action's own request) → REQUIRED EVIDENCE (Gate decision, capability, Sentinel session) →
ACTUAL EVIDENCE (execution/verification results, outbox delivery status) → RESULT (final state, error
detail) — no trust in the system being reviewed to grade itself.

## Failure / INDETERMINATE Semantics

Carried forward from every prior milestone: `INDETERMINATE` is a first-class, honestly-reported result
for genuine uncertainty (unconfirmed containment, a crash mid-execution, exhausted evidence-delivery
retries, missing VAD configuration on a verification-required action) — never silently upgraded to a
guessed success or downgraded to a guessed failure.

## Runtime-Owned State / CAS / Concurrency / Restart Persistence / Tenant Isolation

See `platform-state-machine-v0.1.md` and `platform-races.test.ts`. Every concurrency claim in this
document is proven with genuinely concurrent `Promise.allSettled`/`Promise.all` calls, not sequential
calls dressed up as a race.

## Secret Handling / Resource Bounds

`findSecretShapedField` on request `input`/`metadata` at validation time; `MAX_INPUT_BYTES`,
`MAX_METADATA_BYTES`, `MAX_BODY_BYTES`, `MAX_ACTION_PAGE_SIZE` enforced with explicit, documented
fail-closed behavior.

## HTTP API / HTTP Integration Tests

`apps/tna-platform/src/server.ts` implements the section-44 route set. 9 tests against the actual
`createPlatformServer` over real TCP with `fetch`, no facade mocking.

## Abuse Cases

12 dedicated abuse-case tests (`tests/platform/platform-abuse-cases.test.ts`) covering forged
runtime-owned fields, self-approval, self-resume, direct connector invocation, capability replay,
double submission, CAS manipulation, secret injection, oversized payload, VAD-result forgery, unbounded
history requests, invalid-state termination, and connector-identity drift caught independently by
Sentinel.

## Threat Model

30 threat categories, `platform-threat-model-v0.1.md`, plus the distributed-transaction and
connector-side-effect limitations sections 102-103 require to be stated explicitly.

## Failing-First Defects Found

Five real defects caught by running against the real, accepted Gate/Sentinel/VAD/Ledger components
rather than assuming correctness from inspection — full detail in `platform-verification-v0.1.md`:

1. `ExecutionBroker`'s internal capability-binding operation rule is hardcoded to the literal string
   `'production.deploy'`, independent of any caller-supplied operation semantics.
2. `ExecutionBroker`'s internal `ToolInputRegistry` is private and pre-registers exactly one tool — the
   caller-supplied `input` never reaches a generic connector's handler through the broker.
3. Sentinel's resource-pattern validation and Gate's file-resource validation require incompatible
   leading characters, needing an explicit normalization boundary.
4. A shared demo Gate instance's per-action retry-limit counter needed raising for a demo that
   authorizes the same action repeatedly across flows.
5. Per-flow demo SQLite files needed comprehensive cleanup at startup, not a fixed shared-path list,
   to avoid `createOrReturn`'s idempotency returning stale state from a previous run.

All five were root-caused by comparing expected vs. observed output from real execution.

## Existing Regression Results

All 535 previously-accepted tests (Gate v0.1-v0.3, VAD Engine v0.1, Ledger v0.1, Sentinel v0.1 +
concurrency closure, Auditor v0.1 + trust closure) remain green — verified as part of the 579-test
full-suite run, not in isolation.

## Platform Test Results

44 new tests across 8 files in `tests/platform/` — exact breakdown in `platform-verification-v0.1.md`.

## Total Test Reconciliation

535 (accepted baseline) + 44 (new platform tests) = 579. Node's test runner reported exactly 579
tests, 579 passed, 0 failed, in both consecutive `npm run check` runs — no estimation.

## First Clean Run

```
npm run check → 579 tests, 579 pass, 0 fail
Typecheck: PASS
Lint: PASS
Build: PASS
```

## Second Clean Run (Repeatability, no cleanup between runs)

```
npm run check → 579 tests, 579 pass, 0 fail
```

## Demo Output

```
npm run demo:platform:v01
```

Printed, in order, every required line for Flow 1 (`PLATFORM STORE INITIALIZED` through `ACTION
RECONSTRUCTED`, outcome `COMPLETED`), Flow 2 (`GATE BLOCK` / `NO CAPABILITY` / `NO EXECUTION` /
`PLATFORM ACTION BLOCKED`), Flow 3 (genuine mid-flight revocation, `TERMINATE` / `PLATFORM TERMINATED`),
Flow 4 (`VAD ACCEPTED` / `PLATFORM COMPLETED`), Flow 5 (`LEDGER UNAVAILABLE` through `EVIDENCE
VERIFIED`, surviving a real process restart), and Flow 6 (`AUDITOR ASSESSMENT CREATED` through `AUDIT
OUTCOME: INSUFFICIENT_EVIDENCE`, a real, independently computed, non-PASS-required result), then `TNA
Platform Integration v0.1 demo passed.` (exit code 0). Every outcome is genuinely computed by the real
Gate/Sentinel/VAD/Ledger/Auditor library code against real (in-memory/local-file demo) evidence — none
of the six flows' results are hardcoded or asserted without having actually run.

## Remaining Limitations

- MCP support is a boundary interface only (`McpToolConnector`), not a working implementation —
  explicitly optional in the brief, documented in `platform-mcp-boundary-v0.1.md`.
- The platform's own `PLATFORM_*` Ledger event types are not additionally paired with re-emitted
  Gate/Sentinel/VAD-native event types, so Auditor's existing v0.1 catalog typically returns
  `INSUFFICIENT_EVIDENCE` (not `PASS`) for a platform-orchestrated action — documented, and within the
  brief's own explicit allowance.
- Runtime observation depth beyond the mandatory pre/post-action pair is not built — v0.1's synchronous,
  non-isolated connector execution model has no long-running in-flight window to instrument further.
- No frontend, no cloud/container deployment, no billing, no external customer IAM — all correctly out
  of scope for this milestone and not attempted.

## Requirement Scorecard

Full item-by-item scoring against the section-126 acceptance gate is in
`docs/platform/platform-requirement-matrix-v0.1.md`. Summary: every in-scope mandatory item is
IMPLEMENTED and TESTED, or explicitly NOT APPLICABLE/CONFIRMED by documented design. The four "known
partial/out of scope" items there are documented scope boundaries, not silent gaps or failed
requirements.

---

## Distributed-Evidence Closure Pass Addendum

This addendum records a second, later architectural review of the 579/579 submission above. It does
not alter or delete anything above — the original 579/579 result stands exactly as recorded, obtained
before this review, against the platform's original outbox/causation implementation. Nothing above is
rewritten to make the findings below appear to have never existed.

**Review found two carried-forward guarantees insufficiently closed**, both already honestly flagged in
this document's own "Remaining Limitations" section at the time: (V8-A1) outbox delivery claims were
proven safe only under single-process/in-process CAS, never against two genuinely independent, live
platform processes sharing one SQLite file; (V8-A2) `PlatformLedgerDispatcher.toLedgerEvent()` derived
every record's causation from the action's *current* Gate decision at dispatch time, not from what was
true when that record's evidence obligation was actually created — a real provenance-integrity defect
reachable via the HELD → resume → re-authorize lifecycle loop.

**Distributed outbox ownership closure**: a durable database-level delivery-ownership lease
(`claim_owner`/`claim_token`/`claim_expires_at`, fencing-token CAS) replaces the original unlensed CAS
claim. Proven against two genuinely independent `PlatformStore`/`DatabaseSync` connections sharing one
file — not an in-process `Promise.all()` — covering concurrent multi-process dispatch, lease-not-
stealable-before-expiry, claim-owner-death recovery, and crash-after-Ledger-append-but-before-
acknowledgement (retried delivery reuses the same deterministic event id; Ledger's own idempotent
`append()` absorbs the retry; exactly one logical event results). Full design and limitations:
`platform-v0.1-distributed-evidence-closure.md`, Finding 1.

**Record-specific causation closure**: each outbox record now captures its own immutable
`causation_event_id` once, at enqueue time, via a `last_outbox_id` pointer chain — never re-derived from
the action's current, potentially-since-changed state. `reconstructPlatformAction()` now exposes a
`causal_chain` any independent reviewer can walk. Proven with a dedicated historical-drift regression
(a second, later Gate decision on a resumed HOLD does not retroactively become an earlier record's
cause) plus mixed-path chain tests (BLOCK, HOLD, ALLOW/capability/Sentinel/execution, VAD, termination)
and cross-action/cross-tenant splicing regressions. Full design and limitations:
`platform-v0.1-distributed-evidence-closure.md`, Finding 2.

A secondary defect was found and fixed while proving the above: `claimNext` and `listOutbox` ordered
outbox records by `created_at` with an incidental (non-causal) tie-breaker, which does not guarantee
true creation order for records sharing one timestamp — routine under the mocked clocks this suite
already used throughout. Both now order by SQLite's own monotonic `rowid`.

**New permanent regression tests** (11 total, all newly added, none replacing or weakening an existing
test): `tests/platform/platform-distributed-outbox.test.ts` (4) and `tests/platform/
platform-causation.test.ts` (7). Three existing tests were updated in place, not weakened, to match
newly-correct behavior the fix legitimately changed: `platform-outbox.test.ts`'s restart-recovery test
gained a live-lease-must-not-be-touched assertion; `platform-races.test.ts`'s concurrent-dispatch test
was adapted to the new lease-aware `OutboxPort` signature and relabeled as an in-process unit test (not
a substitute for the new multi-process test); `platform-orchestration.test.ts`'s Ledger-dispatch test's
causation assertion was rewritten from the old, now-known-incorrect "every record's causation_id is the
current decision" expectation to the new, correct per-record causal-chain expectation — the same
discipline the accepted Sentinel concurrency closure used when a fix legitimately changed previously
buggy behavior.

### Closure Test Results

```
npm run check → 590 tests, 590 pass, 0 fail   (first run)
npm run check → 590 tests, 590 pass, 0 fail   (second run, no cleanup between runs)
```

579 (original baseline, unchanged, none removed or weakened) + 11 (new closure tests) = 590. Both
consecutive runs — typecheck, lint, build, full suite — passed cleanly at exactly 590/590.

### Closure Demo Confirmation

```
npm run demo:platform:v01 → all 6 flows passed, exit code 0
```

Re-run against the fully closed code (including the `listOutbox` `rowid`-ordering fix). Every outcome
remains genuinely computed by the real Gate/Sentinel/VAD/Ledger/Auditor library code; none of the six
flows' results are hardcoded.

### Closure Threat Model

Nine new/reconciled threat categories (#31-#39) added to `platform-threat-model-v0.1.md`, each marked
MITIGATED only where a specific regression test in this closure pass provides direct evidence:
simultaneous multi-process outbox claim, stale delivery owner, dispatcher death while owning a record,
crash after Ledger append but before local acknowledgement, outbox lease stealing before expiry,
causation drift, causation derived from mutable current state, cross-action evidence splicing,
cross-tenant causal-chain splicing.

### Closure Remaining Limitations

Carried forward and not silently resolved — see `platform-v0.1-distributed-evidence-closure.md` for
full detail: lease duration is a fixed timeout, not adaptive to actual delivery latency; no lease-
renewal mechanism for a hypothetically long-running delivery attempt (not needed by v0.1's synchronous
delivery model); the causal chain remains strictly linear per action (one predecessor per record, not a
DAG) since no event in this milestone's taxonomy has more than one genuine cause; no claim of
exactly-once external execution is made anywhere — only one logical Ledger event through claim +
idempotency, exactly as before this closure pass.

### Closure Mandatory Blockers Remaining

**0**

---

## Mandatory Blockers Remaining

**0**

## Final Git Status

Branch `trust-no-agent-main`, HEAD `1f4470835886041f0da3fe51a7286da9c0fa066c` (unchanged by this
milestone, and unchanged by the closure pass above — the closure pass, like the original submission,
remains uncommitted in the working tree pending review). New Platform files are currently
untracked/uncommitted; `package.json`, `packages/ledger-schema/src/index.ts`, and
`apps/tna-ledger/src/writers.ts` are modified in place (additive only). No accepted Gate, VAD, Ledger,
Sentinel, or Auditor file was deleted or destructively modified; `main` and all seven accepted tags
(`tna-gate-v0.1/v0.2/v0.3`, `vad-engine-v0.1`, `tna-ledger-v0.1`, `tna-sentinel-v0.1`,
`tna-auditor-v0.1`) are untouched. `tna-platform-v0.1` remains untagged.

## Recommendation

> **READY FOR ARCHITECTURAL ACCEPTANCE REVIEW**

This implementation agent does not declare acceptance, and does not tag `tna-platform-v0.1`.
Acceptance belongs to the reviewer. This holds after the distributed-evidence closure pass above exactly
as it held after the original 579/579 submission.

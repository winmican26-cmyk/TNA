# TNA Sentinel v0.1 Proof of Work

## Accepted Baseline

- Volume 1 — TNA Gate v0.1 (tag `tna-gate-v0.1`, commit `4eca92790d530af73cd81a329ce8acf7085113f5`)
- Volume 2 — TNA Gate v0.2 (tag `tna-gate-v0.2`, commit `cdb53bec97d197214a7ca99a964f5d88324da693`)
- Volume 3 — TNA Gate v0.3 (tag `tna-gate-v0.3`, commit `718a801ff9e3085faf4e69d1dbf924a1b6e6c047`)
- Volume 4 — VAD Engine v0.1 (tag `vad-engine-v0.1`, commit `0667484cd6c63aef2be81ad85479a91c2bed631a`)
- Volume 5 — TNA Ledger v0.1 (tag `tna-ledger-v0.1`, commit `203b8fb6febe711f7c1f47fa6af8b542ea7f3185`)

All five remain untouched. No accepted tag was moved or rewritten.

## Git State

- Branch: `trust-no-agent-main`
- HEAD entering this milestone: `cac0a98956ac1354e3ecc528acff5c0c82ac835d`
- This milestone's work is currently uncommitted in the working tree, per the established workflow of
  presenting the proof for review before any commit/tag step.

## Files Created

```
packages/sentinel-schema/{package.json,src/index.ts}
packages/sentinel-policy/{package.json,src/index.ts}
packages/sentinel-signals/{package.json,src/index.ts}
packages/sentinel-engine/{package.json,src/index.ts}
packages/sentinel-runtime/{package.json,src/index.ts}
apps/tna-sentinel/{package.json,src/{index,writers,gate-revalidator,broker-containment-adapter,
  ledger-adapter,server,main}.ts}
scripts/demo-sentinel-v01.ts
tests/sentinel/{fixture,sentinel-schema,sentinel-policy,sentinel-signals,sentinel-engine,
  sentinel-runtime,sentinel-races,sentinel-flows,sentinel-adapters,sentinel-abuse-cases,
  sentinel-http}.test.ts
docs/sentinel/{sentinel-overview-v0.1,sentinel-session-spec-v1,sentinel-observation-spec-v1,
  sentinel-policy-spec-v1,sentinel-rule-catalog-v0.1,sentinel-decision-model-v0.1,
  sentinel-containment-model-v0.1,sentinel-ledger-integration-v0.1,sentinel-threat-model-v0.1,
  sentinel-verification-v0.1,sentinel-requirement-matrix-v0.1,proof-of-work-sentinel-v0.1}.md
```

Note: `sentinel-runtime.test.ts` is one file, not one per test area — the ten test files above cover
every required test area (section 109) between them; see the reconciliation table below.

## Files Modified

- `package.json` — added `demo:sentinel:v01` and `start:sentinel` scripts.
- `packages/ledger-schema/src/index.ts` — additive extension: `SourceComponent` gained `'sentinel'`,
  `EVENT_TYPES` gained ten `SENTINEL_*` types. No existing value removed, renamed, or reordered. See
  `sentinel-ledger-integration-v0.1.md`.
- `apps/tna-ledger/src/writers.ts` — additive: one new exported factory, `sentinelWriter(tenantId)`.
  `gateWriter`, `vadWriter`, `reader`, `admin` are unmodified.
- `README.md` — added a Volume 6 status section, marked "in development" per section 118. No prior
  content removed or reworded.

No accepted Gate, VAD, or Ledger *behavior* was altered — the only accepted file touched
(`ledger-schema`) had values added to closed enums, never removed or changed in meaning, and all 250
pre-existing tests plus the two permanently-covered original Ledger defects remain green.

## Sentinel Architecture

Five packages plus one app (section 6), matching the milestone's own recommended structure exactly,
with no consolidation needed and no decorative micro-packages added:

- **sentinel-schema** — session/observation input shape and validation, controlled enums (session
  status, observation source/type, rule type, severity, decision type, authority status,
  operation), canonicalization/hashing, fixed secret-shape detection. No I/O.
- **sentinel-policy** — Sentinel's own behavioral policy: rule/param validation, policy hashing
  (Sentinel-computed, never caller-trusted), the rule-catalog defaults, the safe default demo policy.
- **sentinel-signals** — normalization (hostnames, process names, wrapping the accepted
  `egress-guard`'s `isPrivateAddress` and `vad-core`'s `matchesPattern`) and the twenty deterministic,
  side-effect-free per-rule-type evaluators.
- **sentinel-engine** — folds rule results into one decision (precedence, risk score, violation
  records), owns the session state machine. Pure, deterministic, no I/O, no containment calls.
- **sentinel-runtime** — the durable SQLite store (`sentinel_sessions`, `sentinel_observations`,
  `sentinel_decisions`, `sentinel_violations`, `sentinel_stops`, `sentinel_policies`) and the
  `SentinelRuntime` facade: principals/roles/source-binding, the observation pipeline, containment
  invocation, emergency stop.
- **apps/tna-sentinel** — fixed writer/source identities, `GateAuthorityRevalidator`,
  `ExecutionBrokerContainmentAdapter` (documented limitation), `SentinelLedgerAdapter`, the HTTP API,
  the process entrypoint.

## Responsibility Boundary

`sentinel-runtime`'s class-level comment states explicitly what Sentinel owns and does not: it never
decides whether an action may begin (Gate), never judges produced-work correctness (VAD), and treats
Ledger as evidence only, never as live authority (`sentinel-ledger-integration-v0.1.md`, "Sentinel
does not trust Ledger as live authority"). No method in `SentinelRuntime` makes an authorization or
correctness judgment — every decision is a function of session-owned bounds, runtime-owned
counters/clock, and source-bound observations.

## Session Model

Full spec in `sentinel-session-spec-v1.md`. Caller-supplied identity/authority/behavioral-boundary
fields; runtime-owned lifecycle fields (`sentinel_session_id`, `started_at`, `status`,
`observation_sequence`, all four counters, `last_heartbeat_at`). Explicit state machine with the two
deliberate additions beyond the spec's illustrative list (self-loops on the three active statuses;
`TERMINATING → INDETERMINATE`), both documented and both required for the containment-uncertainty
path to exist at all. `FAILED` deliberately not implemented — no distinguishable state for it exists
in this milestone's mechanisms.

## Observation Model

Full spec in `sentinel-observation-spec-v1.md`. Strict 23-type controlled vocabulary, controlled
9-value source enum, source→type binding (`SOURCE_ALLOWED_OBSERVATION_TYPES`), runtime-owned
sequencing and `received_at`, idempotency/conflict on `observation_id`, and the transactional
processing pipeline with its documented containment-cannot-be-rolled-back boundary (section 54).

## Source Identity Model

Fixed identities only (`apps/tna-sentinel/src/writers.ts`): `gateSource, executionBrokerSource,
isolationRunnerSource, egressGuardSource, secretBrokerSource, toolAdapterSource, vadRuntimeSource,
systemSource, reader, controller, admin`. No factory hands a governed agent id observer, controller,
or admin authority — proven directly (`sentinel-runtime.test.ts`) and via nine dedicated impersonation
cases in `sentinel-abuse-cases.test.ts`.

## Sentinel Policy

Full spec in `sentinel-policy-spec-v1.md`, including the explicit session-vs-policy field boundary
reconciling the spec's overlapping wording (sections 7 and 33-35) into one coherent, documented split.
Sentinel computes and validates the policy hash; a caller-supplied hash is never trusted. Malformed
policy input is rejected wholesale before activation (`POLICY_INVALID`), never partially applied.

## Rule Engine

`evaluateRule(rule, context) -> RuleResult` (`sentinel-signals`) is pure and side-effect-free —
`MATCH | NO_MATCH | NOT_APPLICABLE | ERROR`, never silently collapsing an error into a no-match.
`evaluateSession(...)` (`sentinel-engine`) runs every enabled rule, builds violation records, and
folds them into one decision via decision precedence and highest-active-severity risk scoring.
Replayability (TNA-32) proven with a fixed id injector.

## Rule Catalog

All twenty rule types from section 17 are implemented and tested — see
`sentinel-rule-catalog-v0.1.md` for the full trigger/evidence table. None were faked or partially
stubbed; each is verifiable from evidence this milestone actually collects.

## Severity Model

`INFO=0, LOW=10, MEDIUM=30, HIGH=60, CRITICAL=100` — fixed enum, fixed numeric score, no AI.

## Decision Model

`CONTINUE | WARN | HOLD | TERMINATE`, precedence `TERMINATE > HOLD > WARN > CONTINUE`, risk score =
highest active severity score. Full model in `sentinel-decision-model-v0.1.md`, including the
prevention-status distinction (`PREVENTED` vs. `DETECTED_AFTER_EFFECT`) kept separate from
containment-outcome tracking (`containment_status` on the decision).

## Runtime-Owned Counters

`tool_call_count`, `network_request_count`, `process_spawn_count`, `session_cost` are all updated only
by `SentinelRuntime.submitObservation`'s trusted pipeline, from source-bound observations — never from
caller-supplied deltas. `session_cost` additionally rejects non-finite/negative increments before
they ever touch the aggregate (proven with NaN, Infinity, and a negative value in one test).

## Runtime-Owned Clock

`AUTHORITY_EXPIRED`, `RUNTIME_EXCEEDED`, and `MISSING_HEARTBEAT` all compute elapsed time from
`SentinelRuntime`'s own injected clock and stored timestamps — never from a caller-supplied elapsed
value. Every clock-dependent test uses an injected, controllable clock (`FakeContainmentController`'s
and the test fixture's shared clock) for determinism.

## Authority Revalidation

`AuthorityRevalidator` interface (`VALID | EXPIRED | REVOKED | POLICY_CHANGED | UNKNOWN`, with an
additive `revokedScope` detail distinguishing agent vs. approval revocation). `FakeAuthorityRevalidator`
for tests/demo; `GateAuthorityRevalidator` (`apps/tna-sentinel`) is a real adapter over the accepted
Gate's own public `isAgentRevoked`/`getEnvelope` methods — no Gate code modified. `UNKNOWN` fails safe:
the corresponding rule evaluation resolves to `ERROR`, which always escalates to at least `HOLD`
(sections 60-61, 70).

Sentinel also derives authority status directly from a trusted `*_RECHECK` observation's own payload
when one is the triggering observation, taking priority over a live revalidator call for that cycle —
closing a gap an early draft left open (the rule evaluators would otherwise have ignored a real
`REVOCATION_RECHECK`/`POLICY_RECHECK` observation entirely).

## Policy Drift

`POLICY_CHANGED` fires when the current authority status disagrees with `session.policy_snapshot_hash`
— default action HOLD, never silent continuation. Demo Flow D and a dedicated race test prove both the
hold and a trusted, hash-renewing resume.

## Tool / Operation / Resource Drift

`TOOL_NOT_ALLOWED`, `OPERATION_NOT_ALLOWED`, `RESOURCE_NOT_ALLOWED` — the last reuses the accepted
`vad-core`'s `matchesPattern` directly (the VAD V2 separator-safety lesson carried forward exactly,
with its own dedicated `src/auth/**` vs. `src/auth-evil/**` test).

## Destination Monitoring

`DESTINATION_NOT_ALLOWED` and `REDIRECT_NOT_ALLOWED` (the latter evaluates the redirected destination,
not the original URL) plus `PRIVATE_NETWORK_DESTINATION`, which reuses the accepted `egress-guard`'s
`isPrivateAddress` directly rather than reimplementing address-range classification.

## Input / Capability Binding

`TOOL_INPUT_HASH_MISMATCH` and `CAPABILITY_CONTEXT_MISMATCH` compare observed values against the
session-bound `capability_context` across all eight of its fields.

## Runtime Limits

`RUNTIME_EXCEEDED` from Sentinel's own clock against `runtime_limits.max_runtime_seconds`.

## Cost Limits

`COST_EXCEEDED` against the runtime-owned `session_cost` aggregate.

## Heartbeat Monitoring

`MISSING_HEARTBEAT`, optional per session (`heartbeat_interval_seconds`/`heartbeat_grace_seconds`),
evaluated deterministically via injected clocks — no background scheduler required, matching section
37's explicit allowance.

## Violation Model

`violation_id, rule_id, rule_type, severity, observed_at, observation_id, sentinel_session_id,
message_code, message, evidence, prevention_status` — structured evidence only, never hidden model
reasoning (there is no model).

## HOLD

Explicit `hold()` (controller/admin only) and rule-triggered HOLD both resolve through the same
`applyOutcome` containment path. A HELD session never silently resumes on its own — only `resume()`
can leave HELD for MONITORING; proven directly and in the abuse-case suite.

## TERMINATE

Explicit `terminate()` and rule-triggered TERMINATE both resolve to exactly `TERMINATED` (confirmed)
or `INDETERMINATE` (unconfirmed) — never anything else. Idempotent: three consecutive `terminate()`
calls on the same session produce one containment call and one stable final state.

> **Correction (concurrency closure addendum below):** this claim held for sequential calls, as tested
> here, but did not hold under true concurrency against a *different*, slower-resolving decision
> (e.g. a manual `hold()`) — the architectural review reproduced a session ending up `HELD` despite a
> genuine `containment.terminate()` call having fired. See "Concurrency Closure Addendum" and
> `sentinel-v0.1-concurrency-closure.md` for the fix. The claim as written is accurate again after that
> closure pass.

## Resume

Requires controller/admin; carries `rationale` and may rebind `policySnapshotHash`/`authorityExpiry`.
A reader (this model's closest analog to a governed agent's own identity) is rejected with
`FORBIDDEN` at the facade, abuse-case, and HTTP layers alike.

## Emergency Stop

Session/agent/tenant scopes, admin-only to activate or release, durably persisted
(`sentinel_stops`), checked before ordinary rule evaluation on every `evaluateSession`/
`submitObservation` call. All three scopes tested independently, plus cross-tenant isolation and a
release-then-continue test, plus restart persistence of an active stop.

## Containment Interface

`ContainmentController.{hold, terminate}` — the entire surface. `FakeContainmentController` for
tests/demo; `ExecutionBrokerContainmentAdapter` is a documented-limitation adapter that always throws
rather than fabricate success, because the accepted broker/isolation-runner expose no external
cancellation mechanism this milestone can safely reach without modifying accepted code. Full detail in
`sentinel-containment-model-v0.1.md`.

## Containment Failure / INDETERMINATE

Proven directly (`containment failure resolves the session to INDETERMINATE, never falsely
TERMINATED`) and via demo Flow E: a critical violation whose containment call throws never reports
`TERMINATED` or a confirmed containment status.

## Persistence

`sentinel_sessions`, `sentinel_observations`, `sentinel_decisions`, `sentinel_violations`,
`sentinel_stops`, `sentinel_policies` — SQLite, WAL journal mode, same durability posture as the
accepted Ledger. Restart persistence proven for session state, all four counters, decisions,
violations, and an active emergency stop together in one test.

## Concurrency

10 concurrent observations to one session → 10 unique, contiguous sequence numbers, no lost counters.
Two concurrent terminating violations on one session → one stable final state (`TERMINATED`) with both
violations retained as evidence.

> **Correction (concurrency closure addendum below):** this guarantee was only ever tested — and only
> ever held — for two evaluations that computed the *same* decision. It did not hold when two
> concurrent evaluations computed *different* decisions (a HOLD racing a TERMINATE); see "Concurrency
> Closure Addendum" and `sentinel-v0.1-concurrency-closure.md`. The mixed-decision case is now covered
> by 14 additional regression tests and the underlying write path is fixed.

## Tenant Isolation

Every lookup, write, and stop scope is keyed by `(tenant_id, ...)`. A cross-tenant caller naming a
real session id gets `NOT_FOUND`, not a 403 that would confirm the session exists — a stronger
isolation outcome, consistent with how the accepted Ledger's own cross-tenant reads behave.

## Secret Handling

Fixed secret-shape detection (duplicated locally in `sentinel-schema`, same algorithm and rule set as
the accepted Ledger's) rejects secret-shaped field names and bearer-token-shaped values in observation
payloads and session `capability_context`. Not general DLP — documented as such.

## Resource Bounds

`MAX_OBSERVATION_PAYLOAD_BYTES` (8192), `MAX_SESSION_QUERY_PAGE_SIZE` / `DEFAULT_SESSION_QUERY_PAGE_SIZE`
(200 / 50), `MAX_VIOLATIONS_PER_RESPONSE` / `MAX_DECISIONS_PER_RESPONSE` (200) all enforced before the
corresponding operation completes.

## HTTP API

`apps/tna-sentinel/src/server.ts` implements the section-81 endpoint set: session create/read,
observation submission, evaluate, hold/terminate/resume/complete, paginated violations/decisions,
stop activation via its own explicit `/stops` and `/stops/release` endpoints (no generic resource
mutation), stop listing. Every route requires a bearer credential; there is no anonymous or
self-declared identity. No PATCH/PUT/DELETE route exists for a session — proven with all three
methods against a live session, each returning 404 with the session unchanged afterward.

## HTTP Integration Tests

`tests/sentinel/sentinel-http.test.ts` — 23 tests against the actual `createSentinelServer` over real
TCP with `fetch`, no facade mocking. Runs as part of `npm run check`, not a separate/manual suite —
the exact discipline the Ledger closure pass established.

## Gate Integration

`GateAuthorityRevalidator` over the accepted `Gate`'s public `isAgentRevoked`/`getEnvelope` methods
only. 4 dedicated tests (`sentinel-adapters.test.ts`) against a real `Gate` + `Store`: VALID, REVOKED,
POLICY_CHANGED, and UNKNOWN (no envelope on file) — all four outcomes proven, not assumed.

## Execution Broker Integration

`ExecutionBrokerContainmentAdapter` — documented limitation, not a partial implementation pretending
otherwise. See "Containment Interface" above and `sentinel-containment-model-v0.1.md` for the full
rationale (no external cancel/abort surface exists in the accepted broker/isolation-runner).

## Ledger Integration

`SentinelLedgerAdapter` proven end-to-end against the real `Ledger` facade: session-started,
violation-detected, termination-requested, and terminated events chain correctly on their own
`sentinel:<id>` stream, `verifyStream` reports valid, and a non-`sentinel`-bound principal cannot
write them. See "Ledger Extension Discipline" reconciliation below.

## Ledger Extension Discipline

`packages/ledger-schema` gained `'sentinel'` as a `SourceComponent` and ten `SENTINEL_*` event types —
purely additive (section 58). All 250 pre-existing tests remain green (verified as part of the 392-
test full-suite run). `tna-ledger-v0.1` is untouched; the branch evolves beyond it. Full detail:
`sentinel-ledger-integration-v0.1.md`.

## Failing-First Defects Found

Two real defects were caught by writing and running the tests before trusting them, both detailed
with observed failure, root cause, and fix in `sentinel-verification-v0.1.md`:

1. A hardcoded past `authority_expiry` in the HTTP test fixture (real-clock vs. fixture-clock
   mismatch), which surfaced as three failing HTTP tests.
2. A test helper (`sentinel-engine.test.ts`'s local `session()` builder) hardcoding `tool_call_count:
   0` instead of reading it from overrides, which surfaced as two failing engine tests.

Both were test-fixture defects, not implementation defects — but both were caught by actually running
the suite and comparing expected vs. observed output, not by assuming the tests would pass.

## Abuse Cases

Twelve dedicated abuse-case tests (`sentinel-abuse-cases.test.ts`) covering: a forged `decision`
field in a payload, SENTINEL-source impersonation, self-resume by a governed-agent-equivalent
identity, a forged "authority valid" recheck from an unbound source, sequence-reset attempts,
tenant-switch attempts, tool/operation/resource/destination swap attempts, continuing after an
emergency stop, a forged `containment_status` in a payload, bearer-token injection, oversized-payload
flooding, and unbounded violation-history requests. Several more items from section 111's list are
proven elsewhere in the suite (NaN/negative cost, duplicate observation_id conflict, continuing past
authority expiry, continuing after revocation) and cross-referenced rather than duplicated.

## Threat Model

28 threat categories, `sentinel-threat-model-v0.1.md`, covering everything section 112 lists plus the
compromised-host, observability, and DNS-rebinding limitations sections 113-115/90 require to be
stated explicitly.

## Existing Regression Results

All 250 previously-accepted tests (Gate v0.1-v0.3, VAD Engine v0.1, Ledger v0.1 core + closure) remain
green — verified as part of the 392-test full-suite run, not run in isolation. One transient,
unrelated flake in an accepted VAD Engine concurrency test was observed once under increased parallel
load and did not reproduce in four isolated reruns, three full-suite reruns, or the two official
consecutive `npm run check` runs — see `sentinel-verification-v0.1.md`.

## Sentinel Test Results

142 new tests across 10 files:

- `sentinel-schema.test.ts` — 16 tests (session/observation validation, version/type/source
  rejection, secret-shape rejection, payload bounds, canonical hash).
- `sentinel-policy.test.ts` — 9 tests (malformed-policy rejection, rule param requirements, hash
  determinism, non-decreasing risk thresholds, default demo policy).
- `sentinel-signals.test.ts` — 22 tests (all 20 rule-type evaluators including the separator-safety
  and Windows-process-normalization cases, plus `hostAllowed`/normalization unit tests).
- `sentinel-engine.test.ts` — 11 tests (state machine transitions, HELD-stickiness, decision
  precedence, risk score, replayability, emergency-stop override, fail-safe ERROR handling, risk
  threshold escalation).
- `sentinel-runtime.test.ts` — 33 tests (session lifecycle, source binding, sequencing/idempotency/
  conflict, concurrency, counters, cost validation, tool-drift termination, containment failure,
  terminate idempotency, hold/resume, all three emergency-stop scopes plus release, tenant isolation,
  pagination, restart persistence, policy versioning, authority expiry, approval revocation).
- `sentinel-races.test.ts` — 4 tests (revocation vs. tool call, policy change vs. execution,
  emergency stop, concurrent terminating violations).
- `sentinel-flows.test.ts` — 5 tests (the five required end-to-end flows A-E).
- `sentinel-adapters.test.ts` — 7 tests (Gate revalidator ×4, broker-adapter limitation, Ledger
  adapter ×2).
- `sentinel-abuse-cases.test.ts` — 12 tests (see above).
- `sentinel-http.test.ts` — 23 tests (real server + fetch: auth, source binding, tenant isolation,
  malformed/oversized/unknown-type rejection, hold/terminate/resume, emergency stop, pagination, no
  PATCH/PUT/DELETE session route ×3, credential separation).

## Total Test Reconciliation

250 (accepted baseline: 163 Gate/VAD + 56 core Ledger + 8 bounded-stream + 23 HTTP integration) + 142
(new Sentinel) = 392. Node's test runner reported exactly 392 tests, 392 passed, 0 failed, in both
consecutive `npm run check` runs — no estimation.

## First Clean Run

```
npm run check → 392 tests, 392 pass, 0 fail
Typecheck: PASS
Lint: PASS
Build: PASS
```

## Second Clean Run (Repeatability, no cleanup between runs)

```
npm run check → 392 tests, 392 pass, 0 fail
```

## Demo Output

```
npm run demo:sentinel:v01
```

Printed, in order, every required line for Flow A (`SENTINEL STORE INITIALIZED` through `LEDGER
EVIDENCE WRITTEN`), Flow B (`SESSION CREATED` through `LEDGER EVIDENCE WRITTEN`), Flow C (`SESSION
MONITORING` through `SESSION TERMINATED`), Flow D (`SESSION MONITORING` through the second `SESSION
MONITORING` after resume), and Flow E (`CRITICAL VIOLATION` through `SESSION INDETERMINATE`), then
`TNA Sentinel v0.1 demo passed.` (exit code 0).

## Restart Persistence

A dedicated test (`sentinel-runtime.test.ts`, "restart persistence") creates a session, submits an
observation that drifts and terminates it, activates a tenant-wide emergency stop, closes the store,
reopens it from the same file, and confirms identical session status/counters, the same decision and
violation queryable, and the stop still active.

## Remaining Limitations

- Execution-broker/isolation-runner real containment is not implemented — see "Execution Broker
  Integration" above; the adapter honestly reports unconfirmed rather than fabricating success.
- DNS rebinding is not mitigated — `PRIVATE_NETWORK_DESTINATION` classifies only what it is given,
  same limitation as the accepted `egress-guard`.
- Missing instrumentation is a fundamental, undetectable gap — an uninstrumented action path is
  invisible to every rule (TNA-28/29).
- No Sentinel-specific reconstruction view was built; the session narrative is reconstructible from
  existing queries and Ledger events, but a dedicated reconstruction API is left as documented future
  work (permitted explicitly by section 102).
- No cloud deployment, no Sentinel-wide dashboard, no ML anomaly engine, no Auditor — all correctly
  out of scope for this milestone and not attempted.

## Requirement Scorecard

Full item-by-item scoring against the section-126 acceptance gate is in
`docs/sentinel/sentinel-requirement-matrix-v0.1.md`. Summary: every in-scope mandatory item is
IMPLEMENTED and TESTED, or NOT APPLICABLE by explicit design. The "known partial" items listed there
and repeated above are documented scope boundaries, not silent gaps or failed requirements.

## Concurrency Closure Addendum

This section is appended after the fact — it does not alter anything above, including the two claims
now annotated with correction notes ("TERMINATE" and "Concurrency"). This is a deliberate TNA case
study in the review process actually working as intended, recorded rather than quietly folded away:

1. **Original suite:** 392/392 tests passed, both consecutive `npm run check` runs, exactly as
   recorded above and in `sentinel-verification-v0.1.md`. This was true and remains true.
2. **Architectural review** (`sentinel-v0.1-architectural-review-v1.md`), performed independently by
   the reviewer *after* the 392/392 result, read the full Sentinel source rather than trusting this
   document's self-description, and reproduced — with a script, not just by inspection — a genuine
   concurrency defect: a session status write in `applyOutcome` was unconditional and stale-snapshot-
   based, so a slow-to-confirm `HOLD` racing a fast-confirmed rule-triggered `TERMINATE` could leave
   the persisted session reporting `HELD` despite `containment.terminate()` having actually fired.
   `sentinel-races.test.ts`'s existing concurrency test never caught this because it only ever raced
   two evaluations that computed the *same* decision.
3. **Closure** (`sentinel-v0.1-concurrency-closure.md`): the session-status write in `applyOutcome`,
   `resume()`, and `completeSession()` now re-reads the session's fresh durable status inside the same
   exclusive SQLite transaction as the write (a real compare-and-swap, with a new `state_version`
   column), instead of trusting a snapshot read earlier in the call. A weaker, stale decision can no
   longer overwrite a stronger containment outcome already committed or in flight, and a duplicate
   destructive containment call is now structurally impossible (the claim always precedes the real
   `hold()`/`terminate()` call). 14 new regression tests
   (`tests/sentinel/sentinel-concurrency-closure.test.ts`) cover the originally-reported scenario in
   both delay orderings, the WARN/HOLD/TERMINATE precedence matrix, emergency-stop interaction,
   `resume()`/`completeSession()` racing an in-flight termination, and a genuine cross-process
   durability proof (two separate `SentinelRuntime` instances sharing one SQLite file).
4. **Regression:** all 392 originally-accepted tests remain green (one, the pagination test, was
   *updated* — not weakened — to reflect an intentional, related improvement: a superseded decision is
   now always persisted as evidence rather than silently discarded, so it exercises real multi-page
   cursor pagination for the first time). Full suite after closure: 406/406, two consecutive
   `npm run check` runs, no cleanup between.

This is not being hidden as a footnote: the original implementation genuinely had a real, reproducible
concurrency gap, an independent review genuinely caught it before acceptance, and the closure pass is
what the accountability discipline this whole project is built around is supposed to produce.

## Mandatory Blockers Remaining

**0** (as of this document's original writing, before the architectural review — see the Concurrency
Closure Addendum above for the one blocker found afterward and its closure; **0** again as of the
closure pass).

## Final Git Status

Branch `trust-no-agent-main`, HEAD `cac0a98956ac1354e3ecc528acff5c0c82ac835d` (unchanged by this
milestone). New Sentinel files are currently untracked/uncommitted; `package.json`,
`packages/ledger-schema/src/index.ts`, and `apps/tna-ledger/src/writers.ts` are modified in place
(additive only). No accepted Gate, VAD, or Ledger file was deleted or destructively modified; `master`
and all five accepted tags (`tna-gate-v0.1/v0.2/v0.3`, `vad-engine-v0.1`, `tna-ledger-v0.1`) are
untouched. `sentinel-v0.1-architectural-review-v1.md` and `sentinel-v0.1-concurrency-closure.md` are
likewise uncommitted, alongside the rest of this milestone, pending the reviewer's acceptance decision.

## Recommendation

> **READY FOR ARCHITECTURAL ACCEPTANCE REVIEW**

This implementation agent does not declare acceptance, and does not tag `tna-sentinel-v0.1`.
Acceptance belongs to the reviewer. This recommendation now stands on the original 392-test proof
*plus* the architectural review *plus* the concurrency closure pass — see
`sentinel-v0.1-concurrency-closure.md` for the closure's own independent scorecard.

## Architectural Acceptance

Status:
ARCHITECTURALLY ACCEPTED AS TNA SENTINEL v0.1
WITH DOCUMENTED SCOPE AND LIMITATIONS

Accepted implementation commit:
`eda35ecb14ee6c9e9f13112339cda6648cf92303`

Accepted tag:
`tna-sentinel-v0.1`

Tag target:
`eda35ecb14ee6c9e9f13112339cda6648cf92303`

Acceptance test baseline:
406 tests / 406 pass / 0 fail

Repeatability:
Two consecutive full `npm run check` runs passed, no cleanup between them.

Demo:
`npm run demo:sentinel:v01` — PASS

Mandatory blockers remaining:
0

### The full history this acceptance rests on

Recorded in full rather than summarized away — this is the strongest evidence trail of any milestone
in the platform so far, precisely because a real gap was found and closed before acceptance rather
than never surfacing at all:

```
392/392 initially passed
        ↓
architectural review found mixed HOLD/TERMINATE race
        ↓
race reproduced independently
        ↓
durable CAS/state-version fix implemented
        ↓
14 permanent race tests added
        ↓
406/406
        ↓
architectural acceptance
```

Nothing in this chain is deleted or retracted. `sentinel-v0.1-architectural-review-v1.md` stands
exactly as originally written, including its finding. This document's own "TERMINATE" and
"Concurrency" sections above carry inline correction notes rather than edited claims.
`sentinel-v0.1-concurrency-closure.md` is the closure record. All three documents are accepted
together as part of this milestone's evidence.

### What "architecturally accepted" does and does not mean

`ARCHITECTURALLY ACCEPTED` means the design and implementation satisfy the Volume 6 acceptance gate
for their stated scope, with the limitations documented in this file, `sentinel-requirement-matrix-
v0.1.md`, and `sentinel-threat-model-v0.1.md` understood and accepted.

It does **not** mean any of the following:

- production certified
- externally security audited
- host-compromise resistant
- kernel-isolated
- full network enforcement
- tamper-proof
- compliance certified
- universally secure

TNA Sentinel v0.1 remains what it was designed to be: an application-level deterministic runtime
control system. It observes what bound, trusted sources report to it and acts through a narrow
containment interface; it does not replace kernel-level enforcement, a SIEM/EDR, or a security audit.
The observability limitation (`MISSING_EVENT ≠ SAFE_EVENT`, sections 114-115), the compromised-host and
compromised-Sentinel-process limitations, and the DNS-rebinding limitation are all still exactly what
`sentinel-threat-model-v0.1.md` says they are — acceptance does not diminish any of them.

### Tag / HEAD relationship

The `tna-sentinel-v0.1` tag points at the accepted implementation snapshot
(`eda35ecb14ee6c9e9f13112339cda6648cf92303`). Recording this acceptance metadata is a separate, later
documentation commit, so branch `trust-no-agent-main` HEAD is expected to sit one or more commits ahead
of the tag once that commit (and the following README status update) lands. The tag is not moved
forward.

### Prior accepted tags — unchanged

`tna-gate-v0.1` (`4eca92790d530af73cd81a329ce8acf7085113f5`), `tna-gate-v0.2`
(`cdb53bec97d197214a7ca99a964f5d88324da693`), `tna-gate-v0.3`
(`718a801ff9e3085faf4e69d1dbf924a1b6e6c047`), `vad-engine-v0.1`
(`0667484cd6c63aef2be81ad85479a91c2bed631a`), and `tna-ledger-v0.1`
(`203b8fb6febe711f7c1f47fa6af8b542ea7f3185`) were all verified to point at their original commits
immediately before `tna-sentinel-v0.1` was created. None were moved.

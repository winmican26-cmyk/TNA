# TNA Recursive Improvement Governance v0.1 — Proof of Work

## Historical progression

1. Accepted baseline entering this volume: 872/872 (Volume 11, `tna-operator-academy-v0.1`, tag pinned to
   commit `e5d8acf67603f5cc2729a1e9ffd64bbd1bdc7d04`).
2. Four core packages built (`improvement-schema`, `improvement-store`, `improvement-core`,
   `improvement-evaluator`) — pure types, decision functions, SQLite store, workspace/Git/environment
   safety primitives, and the real evaluation orchestration.
3. 60 tests written against those packages standalone.
4. Checkpoint: 932/932 (872 baseline + 60).
5. Packaged governor (`apps/tna-improvement-governor`) built: fail-closed composition root, real HTTP
   routes.
6. Real integrations wired one at a time against already-accepted components, never re-implemented:
   Gate (`apps/tna-gate-api`), VAD (mirroring `apps/tna-platform/src/vad-adapter.ts`), Sentinel
   (`packages/sentinel-runtime`), Ledger (additive `packages/ledger-schema`/`apps/tna-ledger/src/writers.ts`
   extension), and a Volume-12-owned Auditor-equivalent assessment (`packages/auditor-controls`'s own
   catalog is hardcoded/non-pluggable, confirmed by inspection).
7. Real HTTP surface completed end-to-end (propose → authorize → build → evaluate → approve → canary →
   promote → rollback → evidence → lineage).
8. Operator CLI extended with the matching `improvement *` command family and role table.
9. Tenant-isolation suite written — discovered and fixed a real cross-tenant rollback-target vulnerability
   in `ImprovementStore.initiateRollback` (it never validated that the referenced generations belonged to
   the calling tenant before inserting a rollback record).
10. Concurrency suite written (CAS race pairs, TNA-33 stronger-safety-state-never-overwritten checks).
11. Abuse-case suite written (15 named cases).
12. Checkpoint: 122 Volume 12 tests added at that point; 994/994 total, confirmed via two independent full
    `npm run check` runs with identical results (0 fail, 0 skip both times).
13. Git/worktree closure: real disposable-repository integration (`packages/improvement-core/src/
    git-integration.ts`) plus its adversarial test suite (`git-worktree.test.ts`) — accepted-branch
    mutation, tag movement, tag deletion, worktree escape, and out-of-scope mutation all covered. Two real
    bugs found and fixed here (see "Bugs found and fixed" below): `show-ref`'s expected exit-1-on-no-match
    behavior being treated as an error, and `git diff` never reporting brand-new untracked files.
14. Explicit lettered E2E suite (A–J) written (`tests/improvement/e2e-a-to-j.test.ts`) against the real
    packaged governor's real HTTP API. Initial run: 3 passing (A, B, C), 8 failing. Root-caused and fixed
    one bug at a time (see below) until all 11 tests (A–J plus the Ledger-reconstruction sanity check)
    passed.
15. Reward-hacking/holdout fixture built (`improvement/fixtures/reward-hacking/`,
    `tests/improvement/reward-hacking.test.ts`) — 3 tests, including the required counterfactual proof that
    omitting the holdout benchmark would have let the memorizing candidate PROMOTE.
16. Demo (`scripts/demo-recursive-improvement-v01.ts`) rewritten to drive all 6 flows through the real,
    spawned packaged governor process and the real operator CLI binary, unifying it with the packaged
    governor's authoritative orchestration — it previously called `runPromotionEvaluation` and hand-walked
    `store.transitionGeneration` directly, bypassing real Gate authorization, real Sentinel sessions, and
    real CLI role enforcement.
17. Mandatory hardcoded-evidence audit performed across every non-test file in the volume; two real
    constant-placeholder findings fixed.
18. Final verification: `npm run check` run twice (no cleanup between), `npm run smoke:
    recursive-improvement:v01`, `npm run demo:recursive-improvement:v01`, and the E2E A–J suite run
    standalone — all PASS. Final total: 872 accepted baseline + 143 Volume 12 tests = **1015/1015**, 0 fail,
    0 skip.
19. Architectural acceptance review requested at that point.
20. Final documentation closure pass (this pass): the full 16-document set now under `docs/improvement/`
    was written (architecture overview, generation model, spec, classification, authority ceiling,
    mutation boundary, evaluation profile, evaluator independence, capability delta, recursion budget,
    promotion policy, canary policy, rollback, lineage, verification, and the mandatory operator runbook),
    every claim checked against the actual implementation rather than the original kickoff brief's aspirational
    language. TNA-72 through TNA-81 recorded explicitly below. The requirement matrix and threat model were
    reconciled against the now-complete documentation set. No runtime code was changed as part of this pass
    — verification was re-run regardless (see "Test reconciliation" below) and produced the identical
    1015/1015 result.

## Bugs found and fixed during this volume (real, discovered through testing against real components)

Grouped by area; each was found by writing a real test against a real component first, never by
inspection alone, consistent with this project's standing discipline.

**Schema / mutation boundary**
- `classifyMutation` originally let a spec's own `allowed_mutation_paths` neutralize control-plane/
  evaluator-path detection for a low improvement class — fixed to compute forbidden-path/evaluator-path
  detection unconditionally, ignoring what the spec itself claims is allowed.
- A false-positive secret scan flagged `AuthorityCeiling.credentials` as secret-shaped purely by field
  name — fixed by scanning values, not key names, for this structurally-legitimate field.

**Gate integration**
- `registerImprovementGovernor`'s envelope originally bound every operation's `action_bindings` to
  `operation: 'write'`, causing universal BLOCK since `resources.files.write` starts empty for every
  operation except the one (`invoke_candidate_tool`) that legitimately needs write access — fixed to bind
  only that one operation to `'write'`.
- `authorizeImprovementOperation`'s default resource path used a leading slash
  (`/improvement/generations/...`) but `requestFor()` in the governor's own HTTP layer defaulted to the
  same path WITHOUT the leading slash — a real mismatch that caused `gate.approve()` to reject every
  `improvement approve` call with "Undeclared resource or operation." Fixed by aligning both defaults.
- The governor's Gate envelope set `max_retries_per_action: 3`. Gate's retry counter is per-action-name for
  the agent's entire envelope lifetime, not per-resource/generation — this silently BLOCKed every
  `authorize_generation`/`build`/etc. call past the 4th distinct generation the governor would ever process,
  a real defect for a service meant to operate indefinitely. Fixed by raising it to 1000 (matching
  `max_tool_calls`), discovered only once the E2E suite exercised more than 4 generations against one
  shared governor process in one test run.

**VAD integration**
- `VadExecution.attempt({passed:false})` transitions straight to `ESCALATED`/`RETRYING`, never reaching
  `VERIFYING` — the integration originally called `execution.verify()` unconditionally afterward, throwing.
  Fixed to check `execution.lifecycle.current !== 'VERIFYING'` and report the real terminal state instead of
  forcing a call the real lifecycle refuses.

**Sentinel integration**
- `heartbeat_interval_seconds`/`heartbeat_grace_seconds` are optional `RuntimeLimits` fields that
  `createCandidateSession` never forwarded, so `MISSING_HEARTBEAT` could never fire — fixed to accept and
  forward both.
- `POLICY_CHANGED` authority-recheck status was assumed auto-derived from a hash diff; Sentinel actually
  reads the asserted `payload.result` directly — fixed the integration/test to assert it explicitly rather
  than expect automatic derivation.

**Ledger / lineage**
- `reconstructImprovementGeneration`'s `evaluated` field was narrowed to `{decision: string}`, making it
  impossible for the Auditor-equivalent assessment to read `control_plane_changed`/`evaluator_changed`/etc.
  — fixed to expose the raw recorded event payload.

**Packaged governor (`apps/tna-improvement-governor/src/server.ts`)**
- A typo (`deps.adminTokenForAuth` vs. the real `deps.adminToken` field) — fixed.
- `specIdByGeneration` was declared but never populated in `handleCreate`, breaking every later spec
  lookup — fixed.
- `handleEvaluate`'s spec lookup contained a self-referential ternary with two identical branches —
  simplified.
- VAD was originally fed a hardcoded "PASS" regardless of the real regression outcome, defeating the entire
  point of gating on real evidence — fixed to run the real evaluation first and build VAD's evidence from
  the real, just-measured `regressionSuitePassed` boolean.
- `CAPABILITY_DELTA_DETECTED`/`IMPROVEMENT_EVALUATED` Ledger event payloads contained a dead placeholder
  expression (`... !== undefined ? undefined : undefined`) instead of the real computed booleans — fixed,
  requiring `EvaluationResult` to be extended with the real fields the governor needed to record.
- The new `GET /v1/improvements` list route violated `exactOptionalPropertyTypes` — fixed via conditional
  spread.
- **`handleCreate`'s system find-or-create logic was fundamentally broken**: `ImprovementStore.
  createSystem` always mints its own random `system_id`, never the caller's chosen identifier, so
  `store.getSystem(tenantId, input.systemId)` always threw `NOT_FOUND` and a brand-new, disconnected system
  was silently created on every single `propose()` call — even when the caller intended to reuse the same
  system across multiple generations. This silently broke recursion-budget accumulation, stale-parent
  detection, and evaluation-profile staleness detection simultaneously, and was the root cause behind 5 of
  the 8 initially-failing E2E tests. Fixed by adding `ImprovementStore.findSystemByName()` and using it
  consistently — critically, the store's `name` column is always set to `input.systemId` itself (never a
  separately-supplied `systemName`), since a caller-name/internal-id mismatch on the SAME lookup key would
  reintroduce the identical bug the moment a caller supplied a different display name (a second, related
  instance of this bug was found and fixed in the demo script while validating this exact fix).
- The recursion budget was never checked in `handleCreate` at all — fixed by adding the real budget
  check + consume before any generation record is created.
- No stale-parent check existed in `handlePromote` — fixed by comparing the generation's recorded parent
  against the system's current accepted generation.
- `handleRollback` always fabricated `ROLLED_BACK` with no real verification — fixed to call a real
  `verifyRollbackTarget()` (workspace-existence check) first, leaving the record/generation `INDETERMINATE`
  when verification fails.
- The evaluation-profile-staleness map (`POST /v1/systems/:id/evaluation-profile`) wrote under the
  caller-facing system name while `handleEvaluate`/`handlePromote` read by the real internal `system_id` —
  a permanent mismatch that silently defeated the entire staleness check. Fixed to resolve the name to the
  real system first.
- The canary `policy_hash` was a constant placeholder string (`'policy-hash-placeholder'`), making two
  different canary policies indistinguishable in recorded evidence — fixed to compute a real hash of the
  generation's own `spec.canary_policy`.
- `handleEvaluate` could not be called a second time on a generation already in `EVALUATED` (e.g. a Class 5
  HOLD outcome awaiting fresh human/independent approval flags), since the generation state machine has no
  `EVALUATED -> EVALUATING` edge (evaluation is a one-way pipeline step) — fixed by allowing re-evaluation
  in place from `EVALUATED` without re-entering `EVALUATING`, and treating a re-evaluation that lands back
  on the same target state as a legitimate no-op rather than an illegal self-transition.

**Store**
- `initiateRollback` never validated that the referenced generations belonged to the calling tenant before
  inserting a rollback record — a real cross-tenant reference vulnerability, fixed by validating both via
  `getGeneration` (which throws `NOT_FOUND` on cross-tenant reference) before the insert.

**Git integration**
- `git show-ref --tags`/`--heads` exits 1 with empty output when no matching ref exists at all (real,
  documented git behavior for "no results," not a failure) — the generic `git()` helper treated this as an
  error, breaking `snapshotGitRefs()` for any repository state with zero tags. Fixed by special-casing this
  exact case.
- `git diff --name-status` alone never reports brand-new untracked files, so a candidate adding a wholly
  new out-of-scope file would be invisible to mutation-boundary classification — fixed by additionally
  running `git ls-files --others --exclude-standard` and merging those paths in as `added`.

**Test-authoring bugs (not system bugs)**
- The CLI integration test originally tried to transition `EVALUATED -> PROMOTED` directly, which the real
  state machine correctly rejects (promotion must pass through `CANARY`) — fixed by adding the missing
  canary steps.
- The E2E-D fixture's shared `manifest()` helper defaulted `content_hash: null`, which structurally cannot
  exercise hash-swap tamper detection (only removal detection, which does not depend on hashes) — fixed to
  default to a real, non-null hash.
- Several E2E scenarios (E, G, H, I, J) originally used a router fixture (`'general'`-only) that could not
  score at or above the test harness's hardcoded `parentScore: 0.75` baseline on the real 4-case benchmark
  dataset, causing a real benchmark REJECT that masked the actual scenario under test — fixed by using a
  fully-generalizing router fixture consistently across those scenarios' evaluate calls.
- E2E E's original two-generation setup used a naive router for its "already accepted" parent that could
  not itself pass the same benchmark threshold, so the flow's own bootstrap step failed before reaching the
  canary-failure scenario it was meant to exercise — fixed the same way.
- E2E J's fictional `'gen_never_built_or_tracked'` target generation id does not exist as a real row, which
  the (correctly) hardened `initiateRollback` now rejects with `NOT_FOUND` — fixed by constructing a real,
  tenant-owned generation directly at the store level (bypassing `handleCreate`'s workspace bookkeeping) to
  honestly simulate "a real generation whose workspace was never tracked by this governor process," e.g.
  after a governor restart lost its in-memory map.

## The hardcoded-evidence rule (permanent — do not weaken this section in any future revision)

**Authoritative evidence is produced by the component that performed or observed the event. Constants,
fixtures, canned outcomes, and manually asserted PASS objects are not authoritative evidence.**

This rule was discovered, named, and enforced as an explicit audit criterion during this volume's own
construction — not inherited from an earlier volume's documentation. It generalizes every individual bug
fix in this document's "Bugs found and fixed" section: a Ledger event, a promotion decision, a canary
record, or a rollback outcome is only ever trustworthy if the value it carries was actually computed or
observed by the specific component responsible for that fact (the real evaluator for a benchmark score, the
real Gate for an authorization decision, the real Sentinel runtime for a session, the real filesystem for a
workspace-existence check) — never a placeholder standing in for that computation, and never a value
asserted by the same code path that is supposed to be checked against it.

Two real violations of this rule were found and fixed during this volume, and are preserved here
permanently as the concrete precedent for future audits:

1. **Hardcoded canary `policy_hash`**: the packaged governor's `handleCanary` route originally passed the
   literal string `'policy-hash-placeholder'` (and, separately, `'canary-policy-hash-demo'` in the demo
   script) as the canary's recorded policy hash, regardless of what the generation's actual
   `spec.canary_policy` contained. Two structurally different canary policies would have produced
   indistinguishable recorded evidence. **Fixed**: the policy hash is now `hash(canarySpec.canary_policy)`
   — a real hash derived from the actual generation's own canary policy, read back from the store via
   `getSpec()` at canary-start time.
2. **`systemName`/lookup-key mismatch**: `ImprovementStore.createSystem()` always mints its own random
   `system_id`; the packaged governor's `handleCreate` route needed a way to find-or-create a system by the
   caller's own chosen stable identifier. The first fix attempt stored the system's `name` column as
   `input.systemName ?? input.systemId` while looking it up by `input.systemId` — a caller supplying a
   DIFFERENT `systemName` than `systemId` would silently defeat every future lookup, since the stored name
   would never again match the search key, causing a brand-new, disconnected system (and a brand-new,
   unconsumed recursion budget, and a reset evaluation-profile-staleness tracker) to be created on every
   subsequent call. **Fixed**: the store's `name` column is always set to `input.systemId` itself — identity
   and evidence for a system now always resolve against the ACTUAL governed system a caller intends,
   never a display label that could diverge from it. This exact class of bug additionally appeared, and
   was independently found and fixed, in the `POST /v1/systems/:id/evaluation-profile` route.

These two findings are preserved here verbatim as historical fact and must not be rewritten away in any
future revision of this document — they are the concrete evidence that the audit rule above is real and
was actually applied, not merely stated.

## Evidence provenance matrix

| Evidence | Producer | Persisted where | Real execution? | Fixture-only? |
|---|---|---|---|---|
| Gate decision | Real, unmodified `Gate.authorize`/`Gate.approve` (`apps/tna-gate-api`) | Gate's own accepted evidence store (unmodified) | Yes | **NO** |
| VAD verification | Real `verifyCandidateBuild` → real `VadExecution`/`ValidationGate`/`DefaultVerifier` | HTTP evaluate response; not separately persisted to the Ledger beyond the promotion decision | Yes | **NO** |
| Sentinel outcome | Real `SentinelRuntime.createSession`/`submitObservation` | Sentinel's own accepted store (unmodified); `sentinel_session_id` returned in the HTTP response | Yes | **NO** |
| Ledger event / lineage | Real, hash-chained events appended by `improvementWriter()`; reconstructed by `reconstructImprovementGeneration`/`reconstructImprovementLineage` reading ONLY the Ledger | `LedgerStore` | Yes | **NO** |
| Benchmark result | `runPromotionEvaluation`'s real `spawnSync` of the caller-supplied command, real stdout parse, `evaluateBenchmark()` | `PromotionDecision.benchmark_summary_hash`; `IMPROVEMENT_EVALUATED` event | Yes | **NO** |
| Holdout result | Same mechanism as benchmark result — a holdout is simply another real-executed entry in the same `benchmarks` array | Same as benchmark result | Yes | **NO** |
| Mutation diff | `classifyMutation`/`diffDirectoryTrees` over the real isolated workspace filesystem (or real `git diff --name-status` + `git ls-files --others` for the Git-integration path) | `IMPROVEMENT_EVALUATED` event (`control_plane_changed`/`evaluator_changed`) | Yes | **NO** |
| Capability delta | `computeCapabilityDelta` over caller-supplied real parent/candidate profiles | `PromotionDecision.capability_delta_hash`; `CAPABILITY_DELTA_DETECTED` event | Yes (pure computation over real inputs, never a candidate self-report) | **NO** |
| Authority delta | `computeAuthorityDelta` over caller-supplied real before/after ceilings | `PromotionDecision.authority_delta_hash` | Yes (pure computation over real inputs) | **NO** |
| Promotion decision | Pure `evaluatePromotion()` over every signal above | `PromotionDecision` row (`recordPromotionDecision`); `IMPROVEMENT_EVALUATED`/`IMPROVEMENT_PROMOTED`/`IMPROVEMENT_REJECTED` events | Yes | **NO** |
| Canary result | Real `CanaryRun` row (`startCanaryRun`/`recordCanaryObservation`/`endCanaryRun`, CAS-protected); real `policy_hash` (fixed this closure — previously a constant placeholder, see above) | `canary_runs` | Yes | **NO** |
| Rollback result | Real `verifyRollbackTarget()` workspace-existence check (fixed this closure — previously unconditional, see "Bugs found and fixed") | `rollback_records`; generation status | Yes (a documented, minimal workspace-existence check — not a full content-hash re-verification) | **NO** |
| Auditor-equivalent conclusion | `assessImprovementGeneration` over real reconstructed Ledger evidence; `INSUFFICIENT_EVIDENCE` whenever the needed field is absent, never filled with a synthetic PASS | Not separately persisted — computed on read | Yes | **NO** |
| *(for contrast)* Test fixtures themselves (`improvement/fixtures/demo-agent/`, `improvement/fixtures/reward-hacking/`) | N/A — intentionally hardcoded, deterministic toy programs | Repository files | N/A (fixtures, not evidence) | Yes, by design — fixtures are the ONLY category permitted to be hardcoded |

**Every authoritative evidence category above is marked Fixture-only: NO.** The two real deviations found
during the mandatory audit (canary `policy_hash`, the `systemName`/lookup-key mismatch) are both fixed and
reflected in this table's current state. The only row marked otherwise is deliberately the toy fixture
programs themselves, which are not evidence at all — they are the deterministic subject matter the real
evaluator measures.

## Test reconciliation

- Accepted baseline (Volume 11): 872/872
- Volume 12 tests added: 143
- **Total: 1015/1015 — 1015 PASS, 0 FAIL, 0 SKIP**
- `npm run check` (typecheck + lint + test) run twice with no cleanup between: identical results both times.
- `npm run smoke:recursive-improvement:v01`: PASS.
- `npm run demo:recursive-improvement:v01`: PASS (rewritten this closure to drive the real packaged
  governor + CLI, not a separate implementation).
- `node --test dist/tests/improvement/e2e-a-to-j.test.js` run standalone: 11/11 PASS.

## One transient, pre-existing flake observed (recorded factually, not as a Volume 12 defect)

During one `npm run check` run in this volume's build, `tests/academy/process-cleanup.test.ts` (a
pre-existing, already-accepted Volume 11 test) failed once. It was confirmed to pass in isolation and on
immediate full-suite retry. This is attributed to increased resource contention from the substantially
larger number of concurrent real-process-spawning test files Volume 12 introduced (Node's `node --test`
runs test files concurrently by default) — not a logic regression, and not modified as part of this volume
(out of scope: it is accepted Volume 11 code). It has not recurred in any subsequent run performed during
this closure, including the final verification runs recorded above. It is recorded here factually, per
instruction, without being classified as a Volume 12 defect since it has not become reproducible.

## PRINCIPLES — TNA-72 through TNA-81 (recorded)

These are the permanent principles this volume's implementation exists to enforce, recorded now that the
implementation actually supports every one of them (see the cross-references into the rest of
`docs/improvement/` for where each is enforced in code, not merely asserted here).

- **TNA-72 — Improvement Does Not Grant Authority.** A candidate becoming more competent at its task never,
  by itself, widens what it is authorized to do. Enforced by `authorityWithinCeiling`/the separate
  `AuthorityExpansionRequest` path — see `authority-ceiling-v0.1.md`.
- **TNA-73 — A Successor Cannot Certify Its Own Promotion.** No improvement class permits self-promotion
  (`CLASS_POLICY.allow_self_promotion` is `false` for every class, with no override path); the real Gate's
  own accepted role model prevents the candidate from ever being a valid approver principal. See
  `improvement-classification-v0.1.md`, `promotion-policy-v0.1.md`.
- **TNA-74 — Evaluation Infrastructure Must Be Outside the Mutation Boundary.** `packages/improvement-
  evaluator/` is unconditionally, permanently outside every candidate's mutation scope, regardless of
  class or declared `allowed_mutation_paths`. See `evaluator-independence-v0.1.md`.
- **TNA-75 — Recursive Improvement Must Have a Capability Ceiling.** `computeCapabilityDelta`'s
  conservative-by-default unexpected-gain detection means a candidate cannot silently accumulate
  capability outside what was explicitly declared allowable. See `capability-delta-v0.1.md`.
- **TNA-76 — Every Generation Must Be Reversible.** `RollbackPolicy`, real rollback-target verification, and
  the `PROMOTED -> ROLLED_BACK` transition together mean a promoted generation is never a one-way door. See
  `rollback-v0.1.md`.
- **TNA-77 — Improvement History Is Security Evidence.** Terminal states are never deleted; a
  rejected/rolled-back generation's full history remains queryable from the store and independently
  reconstructible from the Ledger alone. See `improvement-generation-model-v0.1.md`, `lineage-v0.1.md`.
- **TNA-78 — Better Performance Does Not Excuse Worse Control.** `evaluatePromotion()`'s precedence order
  checks test-tampering, evaluator independence, control-plane boundary, regression, security, authority,
  and capability BEFORE benchmark results are ever consulted — a higher score cannot override an earlier
  failure. See `promotion-policy-v0.1.md`.
- **TNA-79 — The Ability to Change the Rules Is a Higher Authority Than the Ability to Act.** Class 4/5
  (control-plane/evaluator-affecting changes) require strictly more approval than any competence-only
  change, and the evaluator boundary (TNA-74) applies even to Class 5, which is the class most likely to
  claim legitimate need to touch it. See `improvement-classification-v0.1.md`.
- **TNA-80 — Recursion Must Be Bounded.** `RecursionBudget` is runtime-owned, CAS-updated, and checked as a
  hard stop before any new generation record is created — the candidate has no field that raises its own
  system's limits. See `recursion-budget-v0.1.md`.
- **TNA-81 — Competence May Advance Faster Than Authority.** A candidate is free to iterate rapidly on
  `CLASS_0`/`CLASS_1` competence changes (eligible for automated promotion) while its authority ceiling
  remains completely static until a separate, explicit, human-decided `AuthorityExpansionRequest` widens
  it — the two rates of change are structurally decoupled, never coupled by default. See
  `authority-ceiling-v0.1.md`, `improvement-classification-v0.1.md`.

## LIMITATIONS — what this volume does not establish

Volume 12 does **not** establish that:

- TNA solves AI alignment.
- Recursive self-improvement is universally safe.
- Arbitrary advanced AI cannot escape containment.
- Unknown host/runtime exploits are prevented.
- All emergent capabilities can be detected.
- Benchmarks completely characterize behavior.
- Reward hacking is generally solved.
- Deceptive alignment is solved.
- Kernel/hypervisor compromise is prevented.

**The correct claim is:** TNA governs recursive improvement under defined, implementation-backed control
boundaries and reproducibly tested scenarios.

## Honest scope limitations carried into this acceptance

- **Reward hacking**: the holdout fixture detects one implemented benchmark-gaming class (literal
  memorization of a public benchmark). It does not solve reward hacking generally — see the threat model's
  dedicated scope section.
- **Real MCP/model-change governance**: declared spec fields (`allowed_tool_changes`/
  `allowed_model_changes`) are validated structurally; there is no independent runtime verification of
  actual MCP server behavior or model weight provenance beyond the existing accepted Volume 10 MCP
  boundary.
- **Canary health reporting has no dedicated HTTP route yet**: canary observations (action/failure counts)
  are recorded at the store level directly in tests and in the one scripted store-level demonstration this
  volume ships; there is no `POST .../canary/observation`-style HTTP route yet. The demo and smoke test
  both instead exercise the real, HTTP-reachable operator-triggered rollback path.
- **Rollback verification is a minimal, documented workspace-existence check** (does it exist on disk),
  not a full content-hash-based re-verification of the rollback target's integrity.
- **Test-tamper hash-swap detection requires a real, non-null recorded baseline hash** — a manifest
  recorded with a null hash cannot later have a hash-swap detected against it (removal detection, which
  does not depend on hashes, is unaffected).
- **Documentation set**: as of the final documentation closure pass, this volume ships the full requested
  set under `docs/improvement/`: the architecture overview, generation model, spec, classification,
  authority ceiling, mutation boundary, evaluation profile, evaluator independence, capability delta,
  recursion budget, promotion policy, canary policy, rollback, lineage, verification document, operator
  runbook, threat model, requirement matrix, and this proof-of-work document (18 documents total). TNA-72
  through TNA-81 are recorded explicitly above, in addition to being reflected in code comments at their
  enforcement points throughout the implementation.
- **Auditor-equivalent assessment is Volume 12's own, separate from the accepted `packages/auditor-controls`
  catalog**, which is hardcoded/non-pluggable by design (confirmed by inspection, not an oversight this
  volume could resolve without a separate, larger change to that already-accepted package).

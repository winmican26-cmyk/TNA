# TNA project audit — 2026-09-10

## Verdict

Current position: committed TNA Gate through v0.3, with an untracked, partially remediated VAD Engine v0.1 prototype. The current whole-tree check is not green. Gate's existing 110 tests pass, but additional local probes expose enforcement gaps; VAD is not ready for acceptance or tagging.

This is a source, test, documentation, history and local behavior audit. No application code or existing test was changed. Audit-only reports and reproducible scripts were added. It is not a penetration test of a deployed service or a completed independent security certification.

## What exists

| Layer | Actual implementation | Current assessment |
|---|---|---|
| Gate v0.1 | Strict envelopes, action bindings, agent/admin/approver credentials, ALLOW/BLOCK/HOLD, approvals, revocation, SQLite decision evidence | Preserved regression baseline; useful working foundation |
| Gate v0.2 | HMAC capabilities, one-use consumption, registered broker-only tool path, replay controls, execution transitions | Working local mediation with critical-state and outcome-evidence gaps below |
| Gate v0.3 | Canonical demo tool-input hashing, child-process runner, environment/output/runtime controls, application Egress Guard | Working trusted-demo controls, not hostile-process containment or kernel network enforcement |
| VAD core | Atom schema, hash functions, mock producer, validation/verifier interfaces, lifecycle/budget/human-decision helpers, memory/file stores | Partially implemented; several acceptance safeguards are bypassable or disconnected |
| VAD application | `apps/vad-engine/package.json` only | Exported `src/index.ts` does not exist; no executable VAD app/CLI/demo command |
| Later platform | No deployed Sentinel, Auditor, Ledger UI or frontend found | Do not treat these as delivered or as the next authorized milestone |

Git records: v0.1 `4eca927`, v0.2 `cdb53be`, v0.3 `718a801`. Tags exist for all three. Current branch remains named `tna-gate-v0.2` even though its HEAD contains v0.3. VAD source, tests and documents are untracked, not staged or committed. Existing proof text claiming staged/accepted VAD is not current Git evidence.

## Fresh verification

- `npm run check`: typecheck, lint and build PASS; tests **126 total / 125 pass / 1 fail**, exit 1.
- Gate tests: **110/110 pass**. VAD tests: **15/16 pass**.
- Failure: `file evidence store persists final evidence and prevents conflicting finalization`, at `tests/vad/vad-engine.test.ts:233`.
- Focused VAD rerun reproduces the failure. No stale artifact was deleted to conceal it.
- `npm run demo:v02`: PASS. `npm run demo:v03`: PASS.
- Additional probes reproduce gaps not covered by those passing demos and regression tests.

Exact probe output and the focused failing test output are in [audit-evidence-2026-09-10.md](audit-evidence-2026-09-10.md). Reproduce with `npm run build`, `node docs/audit-probes.mjs`, and `node docs/audit-gate-probes.mjs`.

## Prioritized findings

### P1 — G1: capability redemption outlives approval and runtime authority

`apps/tna-gate-api/src/gate.ts:69` checks current policy issuance and envelope expiry, but not the originating approval's expiry or the agent's runtime window. `apps/tna-gate-api/src/main.ts` wires this same function as both `isPolicyCurrent` and `isDecisionCurrent`. Broker issuance/redemption therefore do not restore those missing checks.

Reproduction: authorize with approval expiry and runtime both 1 second, issue a 30-second capability, advance the clock 2 seconds, redeem. Result: SUCCEEDED and handlerCalls=1. This contradicts the v0.2 requirement that earlier ALLOW is not permanent authorization and approval invalidation ends capability validity.

Fix target: a mandatory current-decision validator that checks original approval linkage/expiry, envelope/issuance, revocation, runtime and binding. Already-consumed approval may remain valid for its linked decision, but must not gain an extended lifetime. Cap capability expiry to the earliest applicable boundary as defense in depth.

### P1 — G2: revocation can occur during an await before invocation

`packages/execution-broker/src/index.ts:89` checks revocation before `await secretBroker.lease(...)` at line 103. No critical-state recheck follows the await. The isolated path also awaits directory creation before starting the runner.

Reproduction: a local fake secret broker sets revocation true during its async lease call. The protected no-op handler still runs and returns SUCCEEDED. An empty lease list also satisfies the current credential-required path, so acquisition presence is not proof that required leases were issued.

Fix target: acquire and validate required leases, then revalidate token expiry, current authority and policy immediately before invocation. Keep transactional redemption/start evidence and clarify the execution boundary. Do not claim revocation cancels an already-running external operation unless a cancellation mechanism exists.

### P1 — G3: successful side effects can be reported as handler failure

`packages/execution-broker/src/index.ts:118` persists SUCCEEDED inside the same try block as execution. If that write fails but the catch-path write succeeds (line 123), the broker records FAILED and throws `Handler failed`, although the handler already completed.

Reproduction: a no-op handler succeeds once; inject failure only for the SUCCEEDED transition. Observed handlerCalls=1, recordedState=FAILED, error=`Handler failed`.

Fix target: separate handler errors from terminal-evidence errors. Retain consumption and report an indeterminate/unavailable outcome after a completion-write failure, with a reconciliation policy. Do not falsely classify a successful external effect as a failed invocation or retry it automatically.

### P1 — V1: validation and verification can report success without proof

`packages/validation-gate/src/index.ts:30` rejects only explicit FAIL. A NOT_RUN record passes; a PASS record with exitCode=1 passes. The gate accepts caller-supplied evidence without running or authenticating a validator.

`packages/verifier-core/src/index.ts:69` constructs a MET result for every criterion before checking evidence. Empty validator evidence and an incorrect spec hash still return ACCEPT. Its missing-criterion check compares a list derived directly from the same criteria, so it cannot establish real criterion coverage. `parse()` also accepts ACCEPT with an empty criteria array.

All cases were reproduced. Fix target: trusted validator execution or verified evidence ingestion, required validator coverage, exit-code/status consistency, exact original-criterion mapping and artifact/spec binding. The verifier must not manufacture evidence references or mark all criteria MET by construction.

### P1 — V2: VAD read permissions allow modifications and path escapes

`packages/vad-core/src/index.ts:176` combines read/write/create scopes when checking changed files. `matchesPattern` at line 166 uses an unrestricted string prefix for `/**`.

With read-only `src/auth/**`, these changed-file entries all return no violation: `src/auth/readonly.ts`, `src/auth-evil/escape.ts`, and `src/auth/../../outside.ts`.

Fix target: operation-aware write/create checks, canonical normalized paths with separator-aware matching, actual workspace change discovery and dependency comparison. Do not rely solely on producer-supplied changed-file lists. OS containment is a separate boundary.

### P1 — V3: acceptance can be persisted before integrity fails

`packages/vad-runtime/src/index.ts:217` calls `finalizeAcceptance` before `lifecycle.transition` at line 227 performs the spec mutation check. The reproduction mutates the spec after verification: `decide()` throws a spec hash mismatch, yet the store already contains an ACCEPTED record.

The standalone `finalizeAcceptance` at line 246 accepts a bare record with claimed nonempty spec/artifact hashes and no original spec, validator results, verifier provenance or human decision. Artifact hashes are supplied strings, not freshly recomputed artifact contents.

Fix target: validate a complete evidence package and current hashes before one atomic acceptance commit. No contradictory persisted ACCEPTED result when finalization rejects. Bind final state, artifact, original spec, verification and human decision in the same durable transaction.

### P1 — V4: runtime limits are caller assertions, not owned counters

`VadExecution.attempt` accepts attempt number, cost, elapsed time and a passed boolean from its caller. `RuntimeBudget` only compares those values with maxima. It does not own monotonic counters, aggregate cost or a clock. A caller can repeat attempt 1 four times with max_attempts=3; the reproduction remains in RETRYING. The mock producer also always reports attempt_number=1.

Fix target: runtime-owned attempts/usage/timestamps, validated finite values, bounded calls, measured or explicitly classified costs, and durable escalation. Integrate active-run locking instead of leaving it as an independent helper.

### P1 — V5: durable acceptance and idempotency are not integrated

`VadExecution` takes the memory-only `EvidenceStore`. `FileEvidenceStore` is separate, uses a read-then-write sequence, has no exclusive/transactional finalization, and is not the store used by the accepted-flow test. A memory Map is not restart-persistent evidence. ActiveExecutionRegistry is also a separate in-memory helper, not acquired by VadExecution.

The file store adds completedAt when writing, then compares a retry's raw input against the enriched stored record. The fixed test fixture survives reruns and produces `Conflicting final evidence`. This is both a repeatability defect and evidence of incomplete idempotency semantics.

Fix target: one persistence interface used by the operational lifecycle, atomic unique acceptance/active-run ownership, complete immutable packages, crash/restart/concurrent-finalization tests and unique cleaned-up test fixtures. Do not solve it only by deleting generated evidence.

### P2 — G4: Egress Guard is standalone and its non-public range coverage is incomplete

Search shows EgressGuard is used by its tests and `scripts/demo-v03.ts`, not by the API or broker. The demo's NETWORK EGRESS BLOCKED line exercises this helper separately; it does not demonstrate child-process network interception.

The range helper returns false for `198.19.0.1`, `224.0.0.1` and `ff02::1`. This permits those address classes past the non-public-address filter when a destination is otherwise allowlisted. The code blocks only part of the benchmark range. A complete policy must define multicast/reserved/non-global behavior explicitly.

No real network tool is currently enabled, and DNS re-resolution/OS-network limitations are documented. Keep those limitations explicit. Before a networked adapter is enabled, wire guarded transport into that adapter and test complete address and redirect policy. Kernel isolation is not implemented and is not a small bug fix.

### P2 — Delivery metadata and documentation have drifted

The root package still reports 0.1.0. Six source directories have no package manifest: capability-core, execution-broker, isolation-runner, egress-guard, tool-inputs and vad-runtime. Relative imports/root compilation work, but these directories are not independently declared npm workspace packages. The VAD app manifest exports a missing file.

README startup omits `TNA_CAPABILITY_KEY`, leaving broker routes disabled while authorization starts. Old VAD proof reports 117 passing tests and claims implementation/acceptance; current code has 126 tests, a failure and the reproduced gaps above. Other review entries say no lifecycle/parser exists, though partial versions have since been added.

Fix target: update current-state documentation and package/application boundaries after behavioral remediation. Preserve old proof as dated history, not as current acceptance evidence.

## What is already valuable

The foundation is not empty scaffolding. Exact action bindings, strict Gate requests, distinct operator/agent credentials, approval replay protection, SQLite transactions and chained evidence exist. HMAC tampering and replay controls, demo input substitution checks, one-use capability concurrency, isolated demo execution and several path/timeout checks have real tests. All 110 existing Gate tests pass now.

The VAD additions include an explicit transition table, a verdict parser, human decision fields and some rejection tests. These partially close older review gaps. The problem is that these pieces do not yet enforce the entire acceptance path, not that nothing has been built.

## What is next on the available blueprint

The clearest next-step authority in the repository is `docs/vad/vad-v0.1-remediation-pass.md`: SPEC → BUILD → PROOF → REVIEW → REMEDIATE → ACCEPT → TAG. It explicitly prohibits VAD v0.2 before VAD v0.1 blockers close. The audit found no authoritative complete roadmap assigning all future volumes, so no later-volume sequence is invented here.

1. Record this audit as the current baseline and keep the Gate tags intact. Do not tag/accept the current VAD tree.
2. Add failing regression cases for G1–G3, fix the Gate critical-state and result-evidence holes, and preserve all 110 Gate regressions. This protects the foundation VAD would rely on.
3. Remediate VAD V1–V2: actual trusted validation, exact criterion evidence, operation-aware resources and dependency checks.
4. Remediate VAD V3–V5: runtime-owned limits, immutable snapshots, actual artifact hashes, durable transactional acceptance, restart/concurrency safety, and strict human decision rules. Current override labels do not enable overriding a disagreeing verifier; choose and enforce the intended policy explicitly.
5. Demonstrate one real end-to-end accepted flow and one rejected/exhausted flow with persisted, reloadable evidence. Add a runnable VAD entrypoint only to the extent required by the existing v0.1 acceptance scope.
6. Run the full check twice without manual evidence cleanup, rerun demos, obtain independent review, update the requirement matrix from current evidence, then commit/tag the accepted VAD v0.1 milestone.

Only after that acceptance should the next scoped blueprint be considered. No Sentinel, Auditor, frontend, cloud integration or new VAD architecture is authorized by this audit.

## Review limitations

This audit preserves source/tests and runs only local demo or in-memory probes. No production deployment, external privileged action or secret integration was exercised. Two independent reviewers were started but hit usage limits before final verdicts; no independent ACCEPT is claimed. A descendant timeout suspicion was inspected but not reproduced on this Windows host and is excluded from confirmed findings. The absence of a finding is not a security guarantee.

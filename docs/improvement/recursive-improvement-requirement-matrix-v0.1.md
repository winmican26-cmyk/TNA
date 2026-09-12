# TNA Recursive Improvement Governance v0.1 Requirement Matrix

Scored against the Volume 12 brief using: **IMPLEMENTED + TESTED**, **IMPLEMENTED**, **PARTIAL**,
**OUT OF SCOPE**, **NOT APPLICABLE**.

| Item | Status | Evidence |
|---|---|---|
| All existing tests remain green | IMPLEMENTED + TESTED | 872 accepted baseline + 143 Volume 12 tests = 1015 total, 1015 pass, 0 fail, 0 skip; `npm run check` run twice with identical results |
| Competence/authority/control-plane separation (TNA-72) | IMPLEMENTED + TESTED | `classifyMutation`, `authorityWithinCeiling`, `computeAuthorityDelta`, `computeCapabilityDelta`; `mutation-boundary.test.ts` |
| `ImprovementGeneration`/`ImprovementSpec` v1 data models | IMPLEMENTED + TESTED | `packages/improvement-schema`; `schema.test.ts` (28 tests) |
| Generation state machine with legal transitions only | IMPLEMENTED + TESTED | `GENERATION_TRANSITIONS`/`canTransition`; enforced by `ImprovementStore.transitionGeneration`; exercised throughout `store.test.ts`, `http.test.ts`, E2E A–J |
| Improvement classes CLASS_0–CLASS_5 with per-class promotion policy | IMPLEMENTED + TESTED | `CLASS_POLICY`; `allow_self_promotion: false` for every class with no override; E2E G (Class 5) |
| `AuthorityCeiling` v1, child-authority-subset invariant | IMPLEMENTED + TESTED | `authorityWithinCeiling`; `mutation-boundary.test.ts`, E2E B |
| `AuthorityExpansionRequest` v1, never inferred from candidate spec | IMPLEMENTED + TESTED | separate record type; `store.test.ts`, `abuse-cases.test.ts` |
| Control-plane mutation boundary, evaluator permanently outside candidate scope (TNA-74) | IMPLEMENTED + TESTED | `classifyMutation` unconditional detection (real bug fixed — see threat model #2); `mutation-boundary.test.ts`, E2E C |
| `RequiredTestManifest` v1, test-tamper detection | IMPLEMENTED + TESTED | `buildRequiredTestManifest`/`detectTestManifestTampering`; `mutation-boundary.test.ts`, E2E D |
| Isolated mutation workspace (path safety, candidate env allowlisting, credential separation) | IMPLEMENTED + TESTED | `assertInsideWorkspace`, `createIsolatedWorkspace`, `candidateEnvironment`; `git-worktree.test.ts` |
| `ImprovementProposal` v1 (untrusted input) | IMPLEMENTED + TESTED | `validateImprovementProposal`; `schema.test.ts` |
| `RecursionBudget` v1, runtime-owned hard stop | IMPLEMENTED + TESTED (real gap closed) | `checkRecursionBudget`/`consumeRecursionBudget`; was NOT enforced in the packaged governor's `handleCreate` until this closure — now fixed; `store.test.ts`, E2E F |
| Real VAD integration | IMPLEMENTED + TESTED | `verifyCandidateBuild` mirrors the accepted `apps/tna-platform/src/vad-adapter.ts` pattern exactly; `vad-integration.test.ts`, E2E A |
| `EvaluationProfile`/`BenchmarkResult` v1 | IMPLEMENTED + TESTED | `evaluateBenchmark`; `schema.test.ts`, `promotion-evaluator.test.ts` |
| Multi-dimensional promotion, security-over-benchmark precedence (TNA-78) | IMPLEMENTED + TESTED | `evaluatePromotion` precedence order; `promotion-evaluator.test.ts` |
| `CapabilityDeltaReport` v1, unexpected-gain detection | IMPLEMENTED + TESTED | `computeCapabilityDelta`, conservative-by-default; `mutation-boundary.test.ts` |
| Real MCP/model-change governance | PARTIAL | `allowed_tool_changes`/`allowed_model_changes` are declared spec fields validated structurally; no independent runtime verification of actual MCP server behavior or model provenance beyond the existing accepted Volume 10 MCP boundary — see threat model #27 |
| Adversarial evaluation requirements | IMPLEMENTED + TESTED | `abuse-cases.test.ts` (15 named cases), reward-hacking holdout fixture (documented narrow scope — see threat model item 7) |
| Deterministic `PromotionEvaluator`, INDETERMINATE > REJECT > HOLD > PROMOTE precedence | IMPLEMENTED + TESTED | `evaluatePromotion`; `promotion-evaluator.test.ts` |
| Human approval / separation of duties | IMPLEMENTED + TESTED | `CLASS_POLICY.requires_human_approval`/`requires_independent_review`; real Gate approver-role enforcement; E2E G |
| Canary deployment through existing Gate/Sentinel/Ledger (never exempted) | IMPLEMENTED + TESTED | `/canary` route authorizes via real Gate, opens a real Sentinel session, real `IMPROVEMENT_CANARY_STARTED` Ledger event; E2E A, E2E E |
| Promotion atomicity | IMPLEMENTED + TESTED | CAS `state_version` on every mutable record; `concurrency.test.ts` |
| Rollback binding before promotion, rollback-never-erases-history | IMPLEMENTED + TESTED | `RollbackRecord`, `initiateRollback`/`completeRollback`; failed-candidate history retained (E2E E); real bug fixed — rollback previously always fabricated `ROLLED_BACK` with no verification, now calls `verifyRollbackTarget()`; E2E J |
| Ledger event types (additive) | IMPLEMENTED + TESTED | 19 new `IMPROVEMENT_*`/`CAPABILITY_DELTA_DETECTED`/`AUTHORITY_EXPANSION_*`/`RECURSION_BUDGET_EXHAUSTED` types added additively to `packages/ledger-schema`, mirroring the Volume 6/7/8 precedent exactly; `ledger-integration.test.ts` |
| Generation lineage reconstruction | IMPLEMENTED + TESTED | `reconstructImprovementGeneration`/`reconstructImprovementLineage`; `lineage.test.ts`, E2E sanity test |
| Sentinel monitoring of candidate/canary execution | IMPLEMENTED + TESTED | `sentinel-integration.ts`; real session per canary; `sentinel-integration.test.ts` |
| "Candidate cannot disable Sentinel" adversarial requirement | IMPLEMENTED + TESTED | candidate has no code path to Sentinel admin/controller principals; `sentinel-integration.test.ts` |
| Auditor-style narrow assessment | IMPLEMENTED + TESTED | `auditor-integration.ts` (9 controls, `INSUFFICIENT_EVIDENCE` never filled with synthetic PASS); `auditor-integration.test.ts`. Honest scope note: this is Volume 12's own equivalent assessment, not a modification to the accepted, non-pluggable `packages/auditor-controls` catalog |
| Packaged governor app, fail-closed startup (mirrors TNA-64) | IMPLEMENTED + TESTED | `apps/tna-improvement-governor`; every dependency a required constructor param, no reduced-mode fallback; `/ready` actually exercises Gate/Ledger/Sentinel/store on every request |
| Real HTTP API with specified routes | IMPLEMENTED + TESTED | `POST/GET /v1/improvements`, `.../authorize|build|evaluate|approve|canary|promote|rollback`, `GET .../evidence|lineage`, `POST /v1/systems/:id/evaluation-profile`, `/live`, `/ready`; `http.test.ts`, E2E A–J |
| Operator CLI extension, same commands | IMPLEMENTED + TESTED | `apps/tna-operator`'s `improvement *` command family; `cli-improvement.test.ts`, packaged smoke test |
| High-risk CLI confirmation/reason requirements | IMPLEMENTED + TESTED | `requireConfirm`/`requireReason` mirror Volume 11's `tenant offboard` fat-finger pattern; enforced for `promote`/`rollback` |
| Ten lettered adversarial E2E scenarios (A–J) | IMPLEMENTED + TESTED | `tests/improvement/e2e-a-to-j.test.ts`, all 11 tests (A–J plus the Ledger-reconstruction sanity check) pass against the real packaged governor's real HTTP API — no substitution of imported functions |
| Real disposable Git/worktree requirements | IMPLEMENTED + TESTED | `packages/improvement-core/src/git-integration.ts`; `git-worktree.test.ts` (7 tests: safe promotion path, branch-checkout protection, tag force-move/delete detection, worktree-escape rejection, out-of-scope-mutation detection, disposable-repo self-check) |
| Concurrency race pairs | IMPLEMENTED + TESTED | `concurrency.test.ts` (6 tests, including TNA-33 stronger-safety-state-never-overwritten checks) |
| Tenant isolation | IMPLEMENTED + TESTED | `tenant-isolation.test.ts` (7 tests, including the real cross-tenant rollback-target vulnerability discovered and fixed during this pass) |
| 15 named abuse cases | IMPLEMENTED + TESTED | `abuse-cases.test.ts` (15 tests) |
| Reward-hacking/holdout fixture with explicit scope caveat | IMPLEMENTED + TESTED | `improvement/fixtures/reward-hacking/`, `tests/improvement/reward-hacking.test.ts` (3 tests: honest-candidate PROMOTE, gamed-candidate REJECT once holdout is required, counterfactual proof that omitting the holdout would have let the gamed candidate PROMOTE). Caveat carried verbatim into the threat model and this matrix: **detects the implemented benchmark-gaming class only, does not solve reward hacking generally** |
| Packaged smoke script | IMPLEMENTED + TESTED | `npm run smoke:recursive-improvement:v01` — spawns the real compiled governor + CLI binaries, full real flow, PASS |
| Demo requirements | IMPLEMENTED + TESTED | `npm run demo:recursive-improvement:v01` — rewritten this closure to spawn the real packaged governor and drive all 6 flows through the real operator CLI, unifying it with the packaged governor's authoritative orchestration (previously a separate, duplicate-truth path — see threat model #26); PASS |
| Architecture overview | IMPLEMENTED + TESTED | `recursive-improvement-overview-v0.1.md` — describes only implemented pipeline stages, cross-referenced against the actual source files listed in each section |
| Generation model documentation | IMPLEMENTED + TESTED | `improvement-generation-model-v0.1.md` — states/transitions/lineage/CAS/cycle-protection matched verbatim against `GENERATION_STATES`/`GENERATION_TRANSITIONS`/`getLineage` |
| ImprovementSpec documentation | IMPLEMENTED + TESTED | `improvement-spec-v0.1.md` — immutability point verified against `ImprovementStore.saveSpec`'s actual hash-comparison behavior |
| Classification documentation | IMPLEMENTED + TESTED | `improvement-classification-v0.1.md` — `CLASS_POLICY` table reproduced exactly from source |
| Authority ceiling documentation | IMPLEMENTED + TESTED | `authority-ceiling-v0.1.md` |
| Mutation boundary documentation | IMPLEMENTED + TESTED | `mutation-boundary-v0.1.md` — includes the unconditional-detection fix and the Git ref-tampering/untracked-file fixes |
| Evaluation profile documentation | IMPLEMENTED + TESTED | `evaluation-profile-v0.1.md` |
| Evaluator independence documentation | IMPLEMENTED + TESTED | `evaluator-independence-v0.1.md` — includes the E2E C proof reproduced verbatim |
| Capability delta documentation | IMPLEMENTED + TESTED | `capability-delta-v0.1.md` — explicitly states TNA does not prove absence of latent emergent capability |
| Recursion budget documentation | IMPLEMENTED + TESTED | `recursion-budget-v0.1.md` |
| Promotion policy documentation | IMPLEMENTED + TESTED | `promotion-policy-v0.1.md` — precedence order reproduced exactly from `evaluatePromotion()`'s actual check sequence |
| Canary policy documentation | IMPLEMENTED + TESTED | `canary-policy-v0.1.md` — states explicitly there is no `canaryPassed=true` assertion model |
| Rollback documentation | IMPLEMENTED + TESTED | `rollback-v0.1.md` |
| Lineage documentation | IMPLEMENTED + TESTED | `lineage-v0.1.md` — includes a concrete worked example (G0→G1 REJECTED, G0→G2 PROMOTED, G2→G3 CANARY FAILED→ROLLED BACK) |
| Threat model | IMPLEMENTED + TESTED | `recursive-improvement-threat-model-v0.1.md` |
| Verification document | IMPLEMENTED + TESTED | `recursive-improvement-verification-v0.1.md` — maps every test file and every E2E scenario to the specific claim it proves |
| Requirement matrix | IMPLEMENTED + TESTED | this document |
| Operator runbook | IMPLEMENTED + TESTED | `recursive-improvement-runbook-v0.1.md` — covers every listed operation, including Class 4/5, authority expansion, and every INDETERMINATE/stale/budget-exhaustion procedure; requires no manual SQLite editing at any step |
| Proof of work | IMPLEMENTED + TESTED | `proof-of-work-recursive-improvement-v0.1.md` — includes the permanent hardcoded-evidence rule, the complete 13-row evidence provenance matrix, and TNA-72–81 recorded explicitly |
| New principles TNA-72 through TNA-81 | IMPLEMENTED + TESTED | recorded explicitly in `proof-of-work-recursive-improvement-v0.1.md`'s dedicated PRINCIPLES section, each cross-referenced to the specific document and code mechanism that enforces it |
| Mandatory hardcoded-evidence audit | IMPLEMENTED + TESTED | performed this closure across every non-test file under `apps/tna-improvement-governor`, `packages/improvement-*`, and the demo/smoke scripts; two real constant-placeholder findings fixed (canary `policy_hash`, `handleCreate`/`systemName` system-identity mismatch); see threat model #25 and the evidence provenance matrix in the proof-of-work document |

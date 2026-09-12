# TNA Recursive Improvement Governance v0.1 — Promotion Policy

Source of truth: `packages/improvement-schema/src/index.ts` (`PROMOTION_STATUSES`,
`combinePromotionSignals`, `evaluatePromotion`), `packages/improvement-evaluator/src/index.ts`
(`runPromotionEvaluation`), and `apps/tna-improvement-governor/src/server.ts` (`handlePromote`).

## `PromotionEvaluator`

`runPromotionEvaluation()` is the real orchestration: it re-checks the parent hasn't gone stale, spawns
real regression/security/benchmark commands, computes real mutation-diff/test-tamper/capability-delta/
authority-delta signals, and calls the PURE `evaluatePromotion()` function with all of it. No LLM anywhere
in this decision path.

## Decision precedence — `PROMOTION_STATUSES` and `combinePromotionSignals`

```
INDETERMINATE (4) > REJECT (3) > HOLD (2) > INSUFFICIENT_EVIDENCE (1) > PROMOTE (0)
```

`combinePromotionSignals()` reduces a list of individual signals to the single most-conservative one. Fail
conservatively: when signals disagree, the more cautious status always wins.

## `evaluatePromotion()`'s actual check order

```
1. !evidenceComplete                                    → INSUFFICIENT_EVIDENCE
2. testTamper.tampered                                   → REJECT ("Required test manifest was tampered...")
3. mutationDiff.evaluator_changed                        → REJECT ("...evaluator independence violated")
4. mutationDiff.control_plane_changed && class < CLASS_4 → REJECT ("Control-plane path(s) touched by a
                                                             {class} candidate...")
5. !regressionSuitePassed                                → REJECT ("Accepted regression suite did not pass")
6. !securityTestsPassed                                  → REJECT ("Security regression suite did not pass")
7. !authorityWithinCeiling                                → REJECT ("...exceeds its approved ceiling")
8. capabilityDelta.has_unexpected_gain                   → REJECT ("Unexpected capability gain: ...")
9. !benchmarksAllPass                                     → REJECT ("...benchmarks did not meet threshold")
10. policy.requires_independent_review && review !== true → HOLD (or REJECT if review === false explicitly)
11. policy.requires_human_approval && approval !== true   → HOLD (or REJECT if approval === false explicitly)
12. otherwise                                             → PROMOTE
```

This exact order is why a benchmark improvement can never rescue a candidate that fails an earlier check —
steps 2 through 8 (tampering, evaluator, control-plane, regression, security, authority, capability) are
ALL evaluated and can ALL REJECT before step 9 (benchmarks) is even reached.

## Benchmark requirements

`benchmarksAllPass` — see `evaluation-profile-v0.1.md`. Requires every configured benchmark to individually
pass AND to have actually produced a real, parseable score.

## Control failures outrank benchmark results — explicitly

**A higher benchmark score cannot override a security/control failure.** This is not implicit in the
precedence order above — it IS the precedence order: `testTamper`, `evaluator_changed`,
`control_plane_changed`, `regressionSuitePassed`, `securityTestsPassed`, `authorityWithinCeiling`, and
`capabilityDelta.has_unexpected_gain` are all checked strictly BEFORE `benchmarksAllPass`. A candidate that
scores perfectly on every benchmark but fails any one of these earlier checks is REJECTed with that
earlier check's specific reason — the benchmark result is never consulted for that decision at all.
Proven directly in E2E B: "benchmark PASS, authority/capability delta FAIL, final REJECT."

## Class 4/5 requirements

Class 4 (`CLASS_4_CONTROL_PLANE`) and Class 5 (`CLASS_5_AUTHORITY_OR_EVALUATOR`) both have
`allow_automated_promotion: false` — they can never reach `PROMOTE` without passing through the
human-approval gate (step 11). Class 5 additionally requires independent review (step 10) — BOTH gates
must clear; approval from only one leaves the generation in `HOLD`. Tested in E2E G.

## Separation of duties

Human approval and independent review are represented as two SEPARATE optional boolean inputs
(`humanApproved`, `independentReviewApproved`) to `evaluatePromotion()`, each `null` (not yet answered),
`true`, or `false` (explicitly denied, which REJECTs rather than HOLDs). In the real governor flow, these
approvals are only ever set via a real Gate-authorized `/approve` call from a genuine `{kind: 'approver'}`
principal — never the candidate itself, and Gate's own accepted role model (unmodified) is what prevents
the candidate from being a valid approver principal at all. Tested in E2E G's self-approval-attempt check.

## Stale evaluator (evaluation-profile staleness)

See `evaluation-profile-v0.1.md`. `handlePromote` blocks (HTTP 409) if the system's active
evaluation-profile hash has changed since the generation was last evaluated. Tested in E2E H.

## Stale parent

`handlePromote` compares the generation's recorded `parent_generation_id` against the system's CURRENT
`accepted_generation_id`. If a DIFFERENT generation was promoted in between — even one also parented on the
same ancestor — promotion is blocked (HTTP 409): *"this candidate's recorded parent is no longer the
system's accepted generation... reevaluate against the current baseline, never a silent rebase."* Tested in
E2E I.

## Stale policy / stale source

`runPromotionEvaluation()` itself re-hashes the real parent workspace (`hashDirectoryTree`) and compares it
against the generation's recorded `source_hash_before` at the START of every evaluation — if the accepted
parent's real content changed since this generation's baseline was recorded, the result is `INDETERMINATE`
("Stale parent: the parent workspace's current content hash... no longer matches..."), never a promotion
computed against a premise that no longer holds.

## Snapshot-bound decision

Every `PromotionDecision` records the exact `spec_hash`, `source_hash`, `evaluation_profile_hash`,
`benchmark_summary_hash`, `security_summary_hash`, `capability_delta_hash`, and `authority_delta_hash` it
was computed against — a decision is a permanent, content-addressed snapshot of what was actually true at
evaluation time, not a live-recomputed claim that could silently drift as underlying state changes later.

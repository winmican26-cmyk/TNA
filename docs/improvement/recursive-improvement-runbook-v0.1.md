# TNA Recursive Improvement Governance v0.1 — Operator Runbook

All commands below are real `tna improvement *` operator CLI commands (`apps/tna-operator`) against the
real, packaged `tna-improvement-governor` HTTP service. **No step in this runbook requires manual SQLite
editing** — every inspection and every action goes through a real CLI command or HTTP route.

Every mutating command requires `--profile <name>` (resolving a role and the governor's URL/token) and, for
high-risk commands, `--reason "<why>"` and `--confirm <exact-generation-id>`. Add `--json` for
machine-readable output (used throughout this runbook for precision).

## Propose

```
tna improvement propose --profile <op> --json --input '{
  "systemId": "sys_my_agent", "systemName": "sys_my_agent", "parentGenerationId": null,
  "parentWorkspacePath": "/path/to/accepted/baseline", "objective": "...",
  "improvementClass": "CLASS_1_CODE", "allowedMutationPaths": ["router.mjs"],
  "authorityCeiling": {...}, "candidateVersion": "v1", "createdBy": "you",
  "requiredBenchmarks": ["..."]
}'
```

`systemId` is your stable identifier for this system across every future proposal against it — use the
SAME value every time you want a new generation to share this system's recursion budget and accepted
-generation tracking (`systemName` is accepted but ignored for lookup purposes in v0.1; do not rely on it
to distinguish systems). The response's `data.generation.generation_id` is what every following command
needs.

If this fails with `429 BUDGET_EXHAUSTED`: see "Handle budget exhaustion" below.

## Inspect classification

`improvement show <generation_id> --json` — the response's `improvement_class` field is the generation's
classification. See `improvement-classification-v0.1.md` for what each class means and what it requires
for promotion.

## Authorize

```
tna improvement authorize <generation_id> --profile <op> --json
```

Real Gate authorization; the generation moves `PROPOSED -> AUTHORIZED`.

## Build

```
tna improvement build <generation_id> --profile <op> --json --input '{"candidateFiles": {"router.mjs": "..."}}'
```

Writes the given files into a fresh, real, isolated workspace copy of the parent (never mutating the
parent). An empty `candidateFiles` object is valid — it builds an unchanged copy of the parent, useful for
bootstrapping a root generation. The response's `data.candidate_workspace` is the real filesystem path, if
you need to inspect it directly.

## Inspect mutation

`improvement diff <generation_id> --json` (alias for `improvement evidence`) shows the reconstructed
evaluation evidence once `/evaluate` has run — `data.reconstruction.evaluated.control_plane_changed` and
`.evaluator_changed` are the two mutation-boundary signals. There is no separate pre-evaluation "diff"
preview command in v0.1 — the mutation classification is computed as part of `/evaluate`, not before it.

## Evaluate

```
tna improvement evaluate <generation_id> --profile <op> --json --input '{
  "regressionTestCommand": [...], "benchmarks": [{"benchmarkId": "...", "command": [...], "threshold": 0, "parentScore": ...}],
  "parentCapabilityProfile": {...}, "candidateCapabilityProfile": {...}, "candidateAuthorityProfile": {...},
  "requiredTestManifestBefore": {...}, "requiredTestManifestAfter": {...}, "evaluationProfileHash": "..."
}'
```

**Read the response's `data.evaluation.reason` string immediately — this is the ONLY place the specific,
human-readable reason for the outcome is surfaced.** The CLI itself reports success (exit 0) only when
`evaluation.status === 'PROMOTE'`; any other status is reported as a CLI-level FAILED result carrying the
same data, so scripts can branch on exit code while still capturing the full reason text.

### Inspect test failures

If `data.evaluation.reason` mentions "regression suite" or "Security regression suite", the corresponding
real spawned command exited non-zero. There is no further breakdown available via HTTP in v0.1 — re-run the
same command directly in the candidate workspace to see its own output if you need more detail.

### Inspect benchmarks

If the reason is "One or more required benchmarks did not meet threshold", at least one entry in your
`benchmarks` array scored below its threshold (`candidate_score - parent_score < threshold`). The specific
per-benchmark scores are not retrospectively queryable via HTTP in v0.1 (see the requirement matrix's
verification document) — capture the `/evaluate` response at the time you make the call if you need to keep
per-benchmark scores for later review.

### Inspect holdout result

A holdout is simply another entry in your `benchmarks` array (see `evaluation-profile-v0.1.md`). If a
holdout entry fails while your public benchmark passed, `evaluation.reason` will still just say "benchmarks
did not meet threshold" — it does not name which specific benchmark failed. To distinguish which one
failed, evaluate with only the holdout benchmark in isolation, or consult
`improvement/fixtures/reward-hacking/`'s test suite for the reference pattern.

### Inspect capability delta / authority delta

```
tna improvement capability-delta <generation_id> --json    (alias for improvement evidence)
```

`data.reconstruction.capabilityDelta.has_unexpected_gain` and `data.reconstruction.evaluated.
authority_within_ceiling` are the two real recorded booleans. `data.assessment.controls` (the
Auditor-equivalent assessment) additionally reports `capability-delta` and `authority-ceiling-compliance`
as PASS/FAIL/INSUFFICIENT_EVIDENCE with a human-readable reason each.

## Approve a high-risk candidate

```
tna improvement approve <generation_id> --profile <security-operator-or-admin> --json --reason "..." --operation <start_canary|promote|rollback|authority_expansion>
```

Requires a real Gate-recognized approver principal — the candidate is never a valid approver, and this is
enforced by the unmodified, accepted `Gate` class, not by this CLI. Returns `data.approval.approvalId`,
required by the next step.

## Start canary

```
tna improvement canary <generation_id> --profile <op> --json --approval <approvalId>
```

Opens a real Sentinel session (`data.sentinel_session_id`) and transitions the generation to `CANARY`.

## Monitor canary

There is no dedicated HTTP route in v0.1 for reporting canary-health observations from a live production
Sentinel deployment (see `canary-policy-v0.1.md`'s honest limitation). In this version, canary
action/failure accounting happens at the store level — a future volume is expected to close this gap with a
real HTTP route.

## Promote

```
tna improvement promote <generation_id> --profile <admin> --json --reason "..." --confirm <generation_id> --approval <approvalId>
```

Will fail with `409` and a message containing "profile" (stale evaluation profile) or "parent" (stale
parent) if either staleness condition applies — see below.

## Reject

There is no separate "reject" command. A generation is REJECTED automatically as the outcome of
`/evaluate` when any check fails (see `promotion-policy-v0.1.md`) — there is nothing further for an
operator to do to reject a candidate; re-evaluating with corrected input is the only forward action if the
rejection was due to a fixable evaluation-input mistake.

## Rollback

```
tna improvement rollback <generation_id> --profile <admin> --json --reason "..." --confirm <generation_id> --approval <approvalId> --target <target_generation_id>
```

Check `data.verified` in the response — `true` means the target's workspace was genuinely confirmed to
exist and the generation is now `ROLLED_BACK`; `false` means it could not be confirmed and the generation
is `INDETERMINATE` instead (see below).

## Handle rollback uncertainty (INDETERMINATE)

If `data.verified === false`: the rollback record and the generation are both left `INDETERMINATE`, never
falsely marked `ROLLED_BACK`. There is no automatic retry in v0.1. Investigate why the target generation's
workspace is not trackable (e.g. the governor process restarted since the target was built, losing the
in-memory workspace map — a documented v0.1 simplification) before attempting rollback again against the
same or a different target.

## Handle stale evaluator (stale evaluation profile)

`409` with "profile" in the error message means the system's active evaluation-profile hash changed since
this generation was last evaluated. Action: re-run `/evaluate` for this generation with the current
criteria, then retry promotion.

## Handle stale parent

`409` with "parent" in the error message means a different generation was promoted (becoming the system's
new accepted baseline) while this candidate was still in flight. Action: there is no "rebase" operation —
propose a fresh generation parented on the NEW accepted generation and start over from `PROPOSED`.

## Handle budget exhaustion

`429` with `data.code: 'BUDGET_EXHAUSTED'` (note: the CLI's top-level `code` field is generically `FAILED`
for this and every other non-403/404 governor error — the specific reason lives one level down, at
`data.code`) means the system's `RecursionBudget` has hit one of its configured limits. There is no
CLI command to reset or raise an existing system's budget in v0.1 — the limits are fixed at the moment the
system's budget row is first created. A genuinely new attempt requires a genuinely new system identifier.

## Reconstruct lineage

```
tna improvement lineage <generation_id> --profile <op> --json
```

Returns `{nodes: [{generationId, parentGenerationId, finalState}], roots: [...]}` reconstructed purely from
real Ledger events for every generation in the same system. See `lineage-v0.1.md`.

## Collect incident evidence

```
tna improvement evidence <generation_id> --profile <op> --json
```

Returns `{reconstruction: {...}, assessment: {...}}` — the full real Ledger reconstruction plus the
Auditor-equivalent 9-control assessment, in one call. This is the single command to run when investigating
an incident involving a specific generation; it requires no other tool and no database access.

```
tna improvement explain <generation_id> --profile <op> --json
```

A deterministic, rules-based one-paragraph summary built from the SAME evidence `evidence` returns — never
an LLM-derived narrative. Useful as a quick human-readable triage step before reading the full evidence.

## Class 4 procedure

A Class 4 (`CLASS_4_CONTROL_PLANE`) proposal must declare `allowedMutationPaths` that legitimately need to
touch control-plane paths — expect `/evaluate` to still enforce every other check (regression, security,
authority, capability, benchmarks) before even reaching the class-policy gate. Promotion requires human
approval (`approve --operation promote`) and can never auto-promote, regardless of how clean the technical
checks are.

## Class 5 procedure

A Class 5 (`CLASS_5_AUTHORITY_OR_EVALUATOR`) proposal requires BOTH `independentReviewApproved: true` AND
`humanApproved: true` in the `/evaluate` input before the outcome can be `PROMOTE` — supplying only one
leaves the generation `HOLD`. Re-run `/evaluate` with the updated approval flags once both are available
(see `improvement-generation-model-v0.1.md`'s note on re-evaluation from `EVALUATED`). A generation that
mutated the evaluator itself will still REJECT unconditionally regardless of class or approval — Class 5
governs the APPROVAL requirement for a spec that declares such intent, it does not grant the mutation.

## Authority expansion procedure

A candidate's own declared authority profile can never widen its ceiling by itself (see
`authority-ceiling-v0.1.md`) — if a candidate genuinely needs more authority, a trusted caller (never the
candidate) must construct a separate `AuthorityExpansionRequest` explicitly stating the requested delta and
reason, then have it approved through the real Gate-authorized `authority_expansion` operation. There is no
CLI shortcut in v0.1 that automates constructing this request from a candidate's spec — it must be composed
explicitly by the operator/orchestration layer.

## INDETERMINATE procedure (general)

Any `INDETERMINATE` result — whether from a stale-parent evaluation, an unverifiable rollback, or a canary
ending uncertain — means evidence was insufficient to resolve cleanly in either direction. The correct next
step is always to gather more evidence (re-evaluate, re-verify, or investigate manually) and never to
manually force a resolution by editing state directly. There is no code path in this volume that lets an
operator override an `INDETERMINATE` status directly to `PROMOTED` or `ROLLED_BACK` without going through
the same real checks every other transition requires.

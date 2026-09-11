# TNA Auditor Risk Model v0.1

No AI, no fuzzy scoring anywhere in this model (section 32). Every number below is a pure function of
controlled enums.

## Risk contribution (per control result)

```
computeRiskContribution(criticality, status):
  PASS, NOT_APPLICABLE        -> 0
  PARTIAL, INSUFFICIENT_EVIDENCE -> round(SEVERITY_SCORE[criticality] * 0.5)
  FAIL, ERROR                 -> SEVERITY_SCORE[criticality]
```

`SEVERITY_SCORE = { INFO: 0, LOW: 10, MEDIUM: 30, HIGH: 60, CRITICAL: 100 }` (same scale as the
accepted Sentinel milestone). `PARTIAL`/`INSUFFICIENT_EVIDENCE` contribute *half* — uncertainty is
risk, not zero (section 100: insufficient evidence must be visible, never buried under "passed").
`ERROR` contributes the *full* score, identical to `FAIL` — an evaluator crash is never safer than a
known failure (section 101).

This is computed once, centrally, in `auditor-controls`' shared `finish()` helper — no individual
evaluator decides its own risk contribution.

## Overall risk score (section 32-33)

```
applicable = results where status != NOT_APPLICABLE
mean = round(sum(risk_contribution for r in applicable) / count(applicable))
critical_floor_applied = any(r in applicable where criticality == CRITICAL and status in {FAIL, ERROR})
overall_risk_score = critical_floor_applied ? 100 : mean
overall_risk_level = bucket(overall_risk_score) using the same INFO/LOW/MEDIUM/HIGH/CRITICAL thresholds
```

Since each result's own `risk_contribution` is already scaled by its criticality, the plain mean
across applicable results is already implicitly weighted — no second weighting pass is needed
("bounded weighted average," section 32's recommended model, realized this way for simplicity and
auditability).

**TNA-39 (the critical-failure floor):** a single CRITICAL-criticality control that FAILs or ERRORs
overrides the mean entirely and forces `overall_risk_score = 100` (`CRITICAL`) — regardless of how
many other controls passed. Proven directly: 25 passing LOW controls alongside one CRITICAL FAIL still
yields `overall_risk_score = 100`, not a diluted average
(`tests/auditor/auditor-risk.test.ts`, "TNA-33/section-33").

## Coverage (sections 35-36)

```
coverage_percentage = applicable_count == 0 ? 0 : round(pass_count / applicable_count * 100)
```

`NOT_APPLICABLE` never counts toward the denominator and never counts as a pass. Reported alongside
the full count breakdown (`pass, partial, fail, insufficient_evidence, not_applicable, error`) — no
false precision (an integer percentage, never `93.742%`).

## Overall outcome (section 38)

```
applicable = results where status != NOT_APPLICABLE
if applicable is empty:                              -> ERROR   (degenerate: nothing to conclude from)
if any applicable CRITICAL result is FAIL:            -> FAIL
if any applicable CRITICAL result is INSUFFICIENT_EVIDENCE or ERROR: -> INSUFFICIENT_EVIDENCE
if every applicable result is PASS:                   -> PASS
otherwise:                                             -> PASS_WITH_FINDINGS
```

`FAIL` is checked before `INSUFFICIENT_EVIDENCE` — a confirmed critical failure always outranks mere
uncertainty about another critical control (proven: "FAIL takes precedence over INSUFFICIENT_EVIDENCE
when both occur among critical controls"). `ERROR` as a *degenerate outcome* (not a per-control
status) is reserved for the case where an assessment's applicable set is empty — a scope/profile
combination that evaluated nothing meaningful is a process anomaly, not a silent pass.

## Finding prioritization (section 98)

`compareFindingPriority`: severity descending, then the originating control's result status
descending (`ERROR > FAIL > INSUFFICIENT_EVIDENCE > PARTIAL > NOT_APPLICABLE > PASS`), then
`finding_id` as a stable final tiebreak. Deterministic total order, proven directly.

## What this model deliberately does not do

No maturity score (section 34 — v0.1 focuses on risk + coverage only, per the recommendation not to
add one unless clearly useful and distinct). No confidence field beyond what `ControlResultStatus`
and `EvidenceSourceTrust` already express (section 99 — "do not use pseudo-statistical confidence").

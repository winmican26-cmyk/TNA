# TNA Sentinel Decision Model v0.1

## Decision types (section 38)

Every evaluation returns exactly one of `CONTINUE | WARN | HOLD | TERMINATE` — never a free-form
string. A decision record carries `decision_id, sentinel_session_id, timestamp, decision,
triggered_rules[], violations[], risk_score, policy_hash, authority_snapshot_hash,
containment_status`.

## Severity (sections 39-40)

`INFO=0, LOW=10, MEDIUM=30, HIGH=60, CRITICAL=100` — a fixed, controlled enum with a fixed numeric
score. No AI, no fuzzy scoring. `risk_score` is the **highest active severity score** among the
violations a single evaluation produced — not a weighted sum, not an average. This is the simplest
rule that is still fully transparent: given the violation list, anyone can recompute the score by
hand.

## Precedence (section 41)

```
TERMINATE > HOLD > WARN > CONTINUE
```

If three rules fire with actions WARN, HOLD, and TERMINATE in the same evaluation, the final decision
is TERMINATE. Implemented as a monotonic precedence-number accumulator (`escalate()` in
`sentinel-engine`), not a mutated decision-typed variable — deliberately, so the logic stays provably
monotonic rather than depending on evaluation order.

## Violation record (section 42)

```
violation_id, rule_id, rule_type, severity, observed_at, observation_id, sentinel_session_id,
message_code, message, evidence, prevention_status
```

`evidence` is a small structured object (the observed value, the expected/allowed value, counts,
thresholds) — never hidden model reasoning, because there is no model.

## Message codes (section 43)

`SENTINEL_<RULE_TYPE>` for every catalog rule (e.g. `SENTINEL_TOOL_NOT_ALLOWED`,
`SENTINEL_AUTHORITY_EXPIRED`), `SENTINEL_EMERGENCY_STOP_ACTIVE` for the stop override, and
`SENTINEL_MANUAL_CONTROL` for an explicit controller action. A rule-evaluation error appends
`_EVALUATION_ERROR` to its would-be code rather than silently vanishing (section 70).

## Rule evaluation results (sections 69-70)

Each rule evaluator returns exactly one of `MATCH | NO_MATCH | NOT_APPLICABLE | ERROR`.
`NOT_APPLICABLE` means the rule's precondition (a certain observation type, a configured allowlist)
was not present in this context — not a judgment about safety. `ERROR` — currently only reachable
when the authority status itself is `UNKNOWN` — always contributes a synthetic HIGH-severity
violation and escalates to at least HOLD; it is never folded into `NO_MATCH`.

## Prevention status (sections 67-68, 92)

A violation's `prevention_status` is `PREVENTED` only when both are true: the triggering observation
describes a not-yet-effected action (`observationPhase` — `TOOL_CALL_REQUESTED`, `NETWORK_REQUEST`,
`PROCESS_STARTED`, `RESOURCE_WRITE/CREATE/DELETE`, `SECRET_LEASE_REQUESTED`) and the decision actually
stops progression (`HOLD` or `TERMINATE`). Everything else is `DETECTED_AFTER_EFFECT` — including a
WARN/CONTINUE match on a pre-action observation, since nothing was actually stopped. Sentinel never
claims to have prevented an already-completed action.

Containment's own outcome is tracked separately, on the decision, as `containment_status`:
`NOT_REQUIRED | CONTAINMENT_REQUESTED | CONTAINMENT_CONFIRMED | CONTAINMENT_UNCONFIRMED` — see
`sentinel-containment-model-v0.1.md`.

## Replayability (TNA-32)

Given the same session, policy, observation, authority status, and clock reading,
`evaluateSession()` always returns the same decision — proven directly with a fixed `newId` injector
in `tests/sentinel/sentinel-engine.test.ts`.

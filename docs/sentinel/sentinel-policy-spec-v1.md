# TNA Sentinel Policy Spec v1

## Shape (section 15)

```
version, policy_id, tenant_id, name, enabled, rules[], default_behavior, risk_thresholds?,
effective_at?, expires_at?, created_at, policy_hash
```

`created_at` and `policy_hash` are runtime-stamped, never caller-supplied — Sentinel computes the
hash over exactly the caller-meaningful fields (everything except `created_at` and `policy_hash`
itself), the same discipline the accepted Ledger applies to its own event hashing.

## Rule shape (section 16)

```
rule_id, rule_type, severity, enabled, action, params?
```

`action` is one of `OBSERVE | WARN | HOLD | TERMINATE` — no free-form action string is accepted.
`params` is only required for the three volumetric rule types (`TOO_MANY_TOOL_CALLS`,
`TOO_MANY_NETWORK_REQUESTS`, `TOO_MANY_PROCESS_SPAWNS`), each needing its own maximum and an optional
`warning_threshold` strictly below it.

## Session vs. policy field boundary

The spec describes some limits (`max_tool_calls`, `max_network_requests`, `max_process_spawns`) as
policy-owned (sections 33-35) and others (`max_runtime_seconds`, `max_cost_usd`, heartbeat
configuration, `allowed_processes`) as session-owned (sections 7, 31-32, 36-37). v0.1 keeps that
split exactly:

- **Session-owned** (bound once at creation, per-execution): identity/expiry bounds, the
  authorized-action identity, the destination/operation/process allowlists, the clock- and
  cost-based limits. These describe *what was authorized for this one execution*.
- **Policy-owned** (tenant-wide, reusable across sessions): which rule types are enabled, their
  severity/action, and the volumetric count thresholds. These describe *how seriously this tenant
  treats each category of violation*.

## Validation and activation (section 71)

Malformed policy input — an unknown `rule_type`, an untrusted `action`/`severity`, a duplicate
`rule_id`, a volumetric rule missing its required `params`, non-ascending `risk_thresholds` — is
rejected wholesale (`POLICY_INVALID`) before anything is stored. There is no partial activation.

## Versioning (section 72)

`setPolicy` never rewrites an existing policy row; it deactivates the tenant's current one and inserts
a new hashed revision. Prior revisions remain queryable history — proven directly in
`tests/sentinel/sentinel-runtime.test.ts` ("replacing the active policy does not retroactively rewrite
prior policy revisions' hash").

## Risk thresholds — escalation only

`risk_thresholds.{warn_at, hold_at, terminate_at}` are an optional overlay evaluated *after* ordinary
rule matching: if the computed `risk_score` meets or exceeds a configured threshold, the final
decision is raised to at least that level. It can never lower what a matched rule already produced —
`evaluateSession`'s `escalate()` only ever moves precedence upward. This keeps the mechanism
transparent and easy to verify by hand (section 21's "avoid semantic policy-diff intelligence unless
deterministic" instruction, applied here too).

## Default demo policy (section 73)

`defaultDemoPolicyInput` enables every one of the twenty rule types at the catalog-default
severity/action (`sentinel-rule-catalog-v0.1.md`), with the volumetric rules pre-configured
(`max_tool_calls: 10` / warn at 8, `max_network_requests: 20`, `max_process_spawns: 5`). It is
explicitly documented, in its own `name` field and here, as a demo/default posture — not a production
recommendation.

# TNA Recursive Improvement Governance v0.1 — Canary Policy

Source of truth: `packages/improvement-schema/src/index.ts` (`CanaryPolicy`, `CANARY_STATUSES`,
`CanaryRun`), `packages/improvement-store/src/index.ts` (`startCanaryRun`/`recordCanaryObservation`/
`endCanaryRun`), `packages/improvement-core/src/sentinel-integration.ts`, and
`apps/tna-improvement-governor/src/server.ts` (`handleCanary`).

## `CanaryPolicy` (part of `ImprovementSpec`)

```ts
interface CanaryPolicy {
  traffic_percent, max_actions, max_runtime_ms, failure_threshold,
  sentinel_terminate_is_failure, cost_threshold_usd,
}
```

## What canary observes

A `CanaryRun` record (`canary_id`, `generation_id`, `policy_hash`, `status`, `actions_executed`,
`failures_observed`, `sentinel_terminations`, `cost_incurred_usd`, `started_at`, `ended_at`,
`state_version`) tracks real, accumulated counters — `recordCanaryObservation()` is a CAS-protected additive
update (actions/failures added, never set), and it only operates on a canary in `RUNNING` status.

`policy_hash` is a real hash of the generation's own `spec.canary_policy`
(`hashValue(canarySpec.canary_policy)`) — computed by the governor's `handleCanary` route at canary-start
time. This was a real bug fixed during this volume's closure: it was previously a constant placeholder
string (`'policy-hash-placeholder'`), which made two different canary policies indistinguishable in
recorded evidence.

## Sentinel participation

`handleCanary` opens a real `SentinelRuntime` session (`createCandidateSession`) bound to the generation,
with `expectedAction: 'improvement.canary'`, `expectedTool: 'improvement.canary.execution'`, and a
generation-scoped `expectedResource`. The real `sentinel_session_id` is returned in the `/canary` HTTP
response — proven real (not fabricated) in E2E A: *"a real Sentinel session must back the canary."* Every
observation type submitted during canary execution (tool calls, network requests, heartbeats,
authority rechecks) is drawn only from Sentinel's own closed, accepted vocabulary
(`OBSERVATION_TYPES`/`OBSERVATION_SOURCES`) — this integration invents no new Sentinel concepts.

## Failure thresholds and promotion eligibility

`CanaryPolicy.failure_threshold` is the configured maximum acceptable `failures_observed /
actions_executed` ratio. `endCanaryRun(tenantId, canaryId, expectedVersion, status)` sets the canary's
final `status` (`PASSED`/`FAILED`/`INDETERMINATE`) — this is a real, CAS-protected transition on the
`CanaryRun` record, not an assertion made elsewhere. **There is no `canaryPassed=true` assertion model
anywhere in this volume** — no code path lets a caller declare a canary passed without going through
`recordCanaryObservation`/`endCanaryRun`'s real, additive, CAS-protected mechanism.

## Rollback trigger

A canary ending `FAILED` is the documented real-world trigger for a `CANARY_HEALTH_FAILURE` rollback (one
of the eight `ROLLBACK_TRIGGERS`). See `rollback-v0.1.md`.

## What constitutes real canary evidence

| Evidence | Real? |
|---|---|
| `sentinel_session_id` | Yes — a real Sentinel session id, returned from a real `createSession` call |
| `canary_id` / `policy_hash` | Yes — a real store row with a real hash of the actual spec's canary policy |
| `actions_executed` / `failures_observed` | Yes when recorded via `recordCanaryObservation` (CAS-protected, additive) |
| Final `status` | Yes when set via `endCanaryRun` (CAS-protected, only from `RUNNING`) |

## Honest v0.1 limitation

There is no dedicated HTTP route yet for an external caller (e.g. a real production Sentinel deployment) to
report a canary-health observation to the governor over the network. In this volume's tests and demo,
canary action/failure counts are recorded directly at the store level (the same real, CAS-protected
`recordCanaryObservation`/`endCanaryRun` methods the governor itself would call) — this is documented, not
hidden, in `tests/improvement/e2e-a-to-j.test.ts` (E2E E) and the runbook. The packaged smoke test and demo
both instead exercise the real, HTTP-reachable OPERATOR-triggered rollback path.

# TNA Sentinel Session Spec v1

## Identity

A Sentinel-monitored activity has a unique `sentinel_session_id`, assigned by the trusted runtime at
creation — never caller-supplied. Uniqueness for every lookup, write, and isolation check is
`(tenant_id, sentinel_session_id)`, the same pattern the accepted Ledger uses for
`(tenant_id, stream_id)`.

## Caller-supplied fields (section 7)

| Field | Meaning |
|---|---|
| `tenant_id`, `agent_id`, `execution_id`, `correlation_id` | identity binding |
| `decision_id?`, `capability_id?` | Gate references, where applicable |
| `authority_snapshot_hash`, `policy_snapshot_hash` | sha256 hex digests of the authority/policy state that made this activity acceptable when the session began |
| `expected_action`, `expected_tool`, `expected_resource` | the authorized action's identity |
| `allowed_destinations[]`, `allowed_operations[]` | the behavioral boundary |
| `allowed_processes?[]`, `allowed_secrets?[]` | optional additional boundaries |
| `authority_expiry` | ISO timestamp; the moment authority is no longer valid regardless of anything else |
| `runtime_limits` (`max_runtime_seconds`, optional heartbeat config), `cost_limits` (`max_cost_usd`) | session-scoped resource bounds |
| `capability_context?` | the bound capability's own identity fields, for drift/mismatch detection |

Only a `controller` or `admin` principal may create a session (section 79-82) — never an observer,
reader, or (by construction) a governed agent, which is never issued any of those identities.

## Runtime-owned fields

`sentinel_session_id`, `started_at`, `updated_at`, `status`, `observation_sequence`,
`tool_call_count`, `network_request_count`, `process_spawn_count`, `session_cost`,
`last_heartbeat_at`. None of these can be set or overridden by a caller — they are computed by
`SentinelRuntime` from its own clock and from validated, source-bound observations.

## `policy_snapshot_hash` vs. Sentinel's own behavioral policy

These are two different things, deliberately: `policy_snapshot_hash` is the hash of whatever
*authorization* policy (e.g. a Gate envelope) made this activity acceptable — Sentinel stores it
opaquely and compares it against what a live `AuthorityRevalidator` reports as current, to detect
drift (section 21). Sentinel's own *behavioral* policy (`packages/sentinel-policy`) is a completely
separate object, selected by `tenant_id` alone, that governs which rule types are enabled and how
severely Sentinel treats a match. A session is never bound to one specific behavioral-policy
revision; every evaluation uses the tenant's current one (section 72's replacement model, applied
per-evaluation rather than per-session).

## State machine (section 8)

```
CREATED       → MONITORING
MONITORING    → MONITORING | WARNED | HELD | TERMINATING | COMPLETED | INDETERMINATE
WARNED        → WARNED | MONITORING | HELD | TERMINATING
HELD          → HELD | MONITORING | TERMINATING
TERMINATING   → TERMINATED | INDETERMINATE
TERMINATED, COMPLETED, INDETERMINATE → (terminal, no further transitions)
```

Two additions beyond the spec's illustrative example list, both deliberate and both proven by tests:

- **Self-loops on MONITORING/WARNED/HELD.** Ordinary operation revisits the same status repeatedly —
  every `CONTINUE` while MONITORING re-enters MONITORING. `HELD → HELD` matters more subtly: a rule
  re-evaluation while HELD that would otherwise compute `CONTINUE`/`WARN`/`HOLD` must **not** silently
  leave HELD — only an explicit, trusted `resume()` may (section 48-49). `nextStatusForDecision`
  encodes this directly: while the current status is `HELD`, only a `TERMINATE` decision can move it
  (to `TERMINATING`); everything else keeps it `HELD`.
- **`TERMINATING → INDETERMINATE`.** Not itemized in the spec's short example list, but required for
  sections 55/92/108 to be representable at all: a `TERMINATE` decision's containment call can fail or
  be unconfirmed, and the session must land somewhere that is honestly not `TERMINATED`.

`FAILED` (mentioned as optional in section 8) is deliberately not implemented: nothing in this
milestone produces a state distinguishable from `TERMINATED` (confirmed stop) or `INDETERMINATE`
(unconfirmed stop) that would need a third terminal outcome. Adding it without a real use would be
exactly the kind of unearned vocabulary section 75/116 warns against.

## Restart persistence

Session identity, status, every runtime-owned counter, and `last_heartbeat_at` are stored in
`sentinel_sessions` (SQLite, WAL) and reloaded verbatim on reopen — proven in
`tests/sentinel/sentinel-runtime.test.ts`'s restart-persistence test alongside decisions, violations,
and an active emergency stop.

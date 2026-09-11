# TNA Sentinel Rule Catalog v0.1

Status language follows section 116: IMPLEMENTED, TESTED, PARTIAL, NOT IMPLEMENTED, NOT APPLICABLE.
Every rule below is IMPLEMENTED and TESTED at the deterministic-evaluator level
(`tests/sentinel/sentinel-signals.test.ts`) and, for the rules exercised by the required flows, at the
end-to-end runtime/HTTP level too.

| Rule type | Default severity / action | Triggers when | Evidence source | Status |
|---|---|---|---|---|
| `AUTHORITY_EXPIRED` | CRITICAL / TERMINATE | Sentinel's own clock passes `session.authority_expiry` | session-owned clock only | IMPLEMENTED, TESTED |
| `APPROVAL_REVOKED` | CRITICAL / TERMINATE | latest authority status is `REVOKED` with `revokedScope: 'approval'` | a trusted `*_RECHECK` observation, or the live `AuthorityRevalidator` | IMPLEMENTED, TESTED |
| `AGENT_REVOKED` | CRITICAL / TERMINATE | latest authority status is `REVOKED` with `revokedScope` unset or `'agent'` | same as above | IMPLEMENTED, TESTED |
| `POLICY_CHANGED` | MEDIUM / HOLD | latest authority status is `POLICY_CHANGED` (current hash ≠ `session.policy_snapshot_hash`) | same as above | IMPLEMENTED, TESTED |
| `TOOL_NOT_ALLOWED` | HIGH / TERMINATE | a tool-call observation's `payload.tool` ≠ `session.expected_tool` | `TOOL_CALL_REQUESTED/STARTED/COMPLETED/FAILED` | IMPLEMENTED, TESTED |
| `OPERATION_NOT_ALLOWED` | HIGH / TERMINATE | a `RESOURCE_*` observation's implied operation is not in `session.allowed_operations` | `RESOURCE_READ/WRITE/CREATE/DELETE` | IMPLEMENTED, TESTED |
| `RESOURCE_NOT_ALLOWED` | HIGH / TERMINATE | `payload.resource` does not match `session.expected_resource` (separator-aware glob, VAD V2 lesson) | any observation carrying `resource` | IMPLEMENTED, TESTED |
| `DESTINATION_NOT_ALLOWED` | HIGH / TERMINATE | `payload.destination` not in `session.allowed_destinations` (exact or `*.suffix`) | `NETWORK_REQUEST` | IMPLEMENTED, TESTED |
| `PRIVATE_NETWORK_DESTINATION` | HIGH / TERMINATE | destination/resolved address is loopback or a non-public range (reuses `egress-guard`'s `isPrivateAddress`) | `NETWORK_REQUEST`/`NETWORK_REDIRECT` | IMPLEMENTED, TESTED |
| `REDIRECT_NOT_ALLOWED` | HIGH / TERMINATE | a redirect's `payload.to` is not authorized — the *redirected* destination is evaluated, not the original URL | `NETWORK_REDIRECT` | IMPLEMENTED, TESTED |
| `RUNTIME_EXCEEDED` | MEDIUM / HOLD | Sentinel's own clock shows elapsed runtime past `runtime_limits.max_runtime_seconds` | session-owned clock only | IMPLEMENTED, TESTED |
| `COST_EXCEEDED` | MEDIUM / HOLD | runtime-owned `session_cost` exceeds `cost_limits.max_cost_usd` | `COST_REPORTED` accumulation | IMPLEMENTED, TESTED |
| `TOO_MANY_TOOL_CALLS` | MEDIUM / HOLD | runtime-owned `tool_call_count` exceeds policy `params.max_tool_calls`; a softer WARN/LOW fires at `warning_threshold` | `TOOL_CALL_REQUESTED` counter | IMPLEMENTED, TESTED |
| `TOO_MANY_NETWORK_REQUESTS` | MEDIUM / HOLD | runtime-owned `network_request_count` exceeds `params.max_network_requests` | `NETWORK_REQUEST` counter | IMPLEMENTED, TESTED |
| `TOO_MANY_PROCESS_SPAWNS` | MEDIUM / HOLD | runtime-owned `process_spawn_count` exceeds `params.max_process_spawns` | `PROCESS_STARTED` counter | IMPLEMENTED, TESTED |
| `UNEXPECTED_PROCESS` | HIGH / TERMINATE | a started process's executable (normalized: lowercase, Windows suffix stripped) is outside `session.allowed_processes`, when that allowlist is configured | `PROCESS_STARTED` | IMPLEMENTED, TESTED |
| `SECRET_LEASE_NOT_ALLOWED` | HIGH / TERMINATE | a requested secret lease name is outside `session.allowed_secrets`, when configured | `SECRET_LEASE_REQUESTED` | IMPLEMENTED, TESTED |
| `TOOL_INPUT_HASH_MISMATCH` | CRITICAL / TERMINATE | a tool call's `payload.input_hash` disagrees with `session.capability_context.input_hash` | `TOOL_CALL_REQUESTED/STARTED` | IMPLEMENTED, TESTED |
| `CAPABILITY_CONTEXT_MISMATCH` | CRITICAL / TERMINATE | an observed `capability_context` disagrees with the session-bound one on any of `capability_id, decision_id, agent_id, tool, operation, resource, expiry, input_hash` | any observation carrying `capability_context` | IMPLEMENTED, TESTED |
| `MISSING_HEARTBEAT` | MEDIUM / HOLD | Sentinel's own clock shows no heartbeat within `heartbeat_interval_seconds + heartbeat_grace_seconds`, when configured | `EXECUTION_HEARTBEAT` timestamps + clock | IMPLEMENTED, TESTED |

## Not a rule type, but part of the same evidence trail

- **`EMERGENCY_STOP`** (section 50) — a synthetic, non-configurable override applied before ordinary
  rule evaluation whenever an active stop scope covers the session. Always CRITICAL / TERMINATE.
  Deliberately excluded from the policy-configurable `RuleType` enum so no policy can weaken or
  disable it.
- **`MANUAL_CONTROL`** — attached to the single violation record an explicit controller-initiated
  `hold()`/`terminate()` produces, so the operator's stated reason is never lost from the evidence
  trail even though no catalog rule matched.

## Rule types intentionally not implemented

None. Every rule type listed in section 17 is implemented, because every one of them can be verified
reliably from evidence this milestone actually collects — session-owned bounds, runtime-owned
counters/clock, and source-bound observations. No rule was faked or partially stubbed.

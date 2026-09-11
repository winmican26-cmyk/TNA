# TNA Sentinel Observation Spec v1

## Shape (section 9)

Every observation input carries `version, observation_id, tenant_id, sentinel_session_id, timestamp,
source, observation_type`, plus an optional bounded `payload` (≤ `MAX_OBSERVATION_PAYLOAD_BYTES` =
8192 bytes, secret-scanned with the same fixed rule set the accepted Ledger uses). The runtime alone
assigns `sequence` and `received_at` — the producer's own `timestamp` is retained as informational
context, never as the ordering key.

## Observation types (section 10)

```
EXECUTION_STARTED
TOOL_CALL_REQUESTED, TOOL_CALL_STARTED, TOOL_CALL_COMPLETED, TOOL_CALL_FAILED
RESOURCE_READ, RESOURCE_WRITE, RESOURCE_CREATE, RESOURCE_DELETE
NETWORK_REQUEST, NETWORK_REDIRECT
PROCESS_STARTED, PROCESS_EXITED
SECRET_LEASE_REQUESTED, SECRET_LEASE_GRANTED, SECRET_LEASE_RELEASED
COST_REPORTED
AUTHORITY_RECHECK, POLICY_RECHECK, REVOCATION_RECHECK
EXECUTION_HEARTBEAT, EXECUTION_COMPLETED, EXECUTION_FAILED
```

An unrecognized type is a hard `UNKNOWN_OBSERVATION_TYPE` rejection — no silent coercion, no
best-effort interpretation.

## Source authenticity (sections 11-12)

A controlled `ObservationSource` enum (`TNA_GATE, EXECUTION_BROKER, ISOLATION_RUNNER, EGRESS_GUARD,
SECRET_BROKER, TOOL_ADAPTER, VAD_RUNTIME, SENTINEL, SYSTEM`) is bound to an allowlist of observation
types each source may submit (`SOURCE_ALLOWED_OBSERVATION_TYPES` in `sentinel-schema`). A principal is
bound to one or more sources at creation (`apps/tna-sentinel/src/writers.ts`'s fixed identities); an
observer credential can never submit a type outside its bound sources' allowlists, regardless of what
the request claims. A random agent cannot submit `EXECUTION_COMPLETED` as trusted system evidence —
there is no factory that hands a governed agent any observer identity at all.

## Authority/policy/revocation rechecks as observations

`AUTHORITY_RECHECK`, `POLICY_RECHECK`, and `REVOCATION_RECHECK` are ordinary, source-bound
observations (submitted in practice by `TNA_GATE` or `SENTINEL` itself) whose `payload` states a
finding: `{ result: 'VALID' | 'EXPIRED' | 'REVOKED' | 'POLICY_CHANGED' | 'UNKNOWN', scope?: 'agent' |
'approval', current_policy_hash?: string }`. When one of these observations triggers an evaluation,
its payload is authoritative for that cycle (`authorityStatusFromObservation` in
`sentinel-runtime`) — otherwise, an `evaluateSession()` recheck falls back to a live
`AuthorityRevalidator` if one is wired (section 60-61). Both paths feed the same `AGENT_REVOKED` /
`APPROVAL_REVOKED` / `POLICY_CHANGED` rule evaluators; see `sentinel-rule-catalog-v0.1.md`.

## Sequencing (sections 13, 54)

`sequence` is assigned inside the same transaction that persists the observation and advances the
session's `observation_sequence` counter — monotonic, contiguous, and impossible for a caller to
reset or choose (proven with repeated `observation_id`s and with 10 concurrent submissions all
receiving unique sequential numbers).

## Idempotency (section 14)

Same `observation_id` + identical canonical content → the original row and its already-computed
decision context are returned untouched, no new sequence consumed, no duplicate risk signal. Same
`observation_id` + different content → `OBSERVATION_CONFLICT`.

## Processing pipeline (section 54)

```
validate observation → assign runtime sequence → persist observation → update counters →
evaluate applicable rules → persist violations → persist decision → invoke containment if needed
```

The first four steps run inside one SQLite `BEGIN IMMEDIATE` transaction. Evaluation and containment
happen afterward, deliberately outside that transaction: containment is an external effect and cannot
be rolled back by SQLite. If evaluation or containment throws after the observation has already been
durably persisted, the observation and its sequence number stand — they are real evidence of what was
received — while the decision/containment outcome is resolved (or left `INDETERMINATE`) separately.
This is the same side-effect/evidence boundary the accepted Gate G3 lesson established.

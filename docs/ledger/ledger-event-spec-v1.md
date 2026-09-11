# TNA Ledger Event Spec v1.0

Status: IMPLEMENTED, TESTED

## Purpose

Defines the strict, versioned shape every Ledger event must satisfy before it can be persisted.
Validation lives in `packages/ledger-schema/src/index.ts` (`validateEventInput`).

## Required fields

| Field | Type | Notes |
|---|---|---|
| `version` | `"1.0"` | Only supported value. Anything else is rejected (`UNSUPPORTED_VERSION`), not reinterpreted. |
| `event_id` | safe id string | Caller-supplied but format-validated (`^[A-Za-z0-9][A-Za-z0-9._:-]*$`, ≤200 chars). Doubles as the idempotency key. |
| `event_type` | controlled enum | One of the 32 types in the v1.0 registry (see `ledger-event-types` below). Unknown types are rejected, not stored. |
| `tenant_id` | safe id string | Required on every event. See `ledger-stream-model-v1.md`. |
| `stream_id` | safe id string | The hash-chain partition this event belongs to. |
| `actor` | `{ type, id }` | `type` is one of `AGENT, HUMAN, SYSTEM, SERVICE, VERIFIER, PRODUCER, ADMIN, APPROVER`. Free-form actor types are rejected. |
| `correlation_id` | safe id string | Groups every event belonging to one workflow (one Gate action, one VAD atom). |
| `source_component` | controlled enum | One of `tna-gate, execution-broker, isolation-runner, vad-engine, human-decision-service, ledger`. An untrusted or unlisted origin is rejected outright — not merely logged as suspicious. |

## Optional fields (absence is explicit)

- `causation_id`, `parent_event_id` — the specific prior event this one is a direct consequence of, distinct from `correlation_id` (see `ledger-stream-model-v1.md` §causation).
- `occurred_at` — a source-claimed ISO-8601 UTC timestamp. Validated but never authoritative for ordering (`ledger-integrity-model-v1.md` §clock ownership).
- `authority_context`, `spec_context`, `execution_context`, `artifact_context` — structured provenance blocks (sections below). Each is `undefined` when it does not apply; a field that exists but is empty is not the same as a field that was never provided.
- `payload` — bounded structured metadata (≤8192 bytes canonical, `MAX_PAYLOAD_BYTES`). Oversized payloads are rejected before persistence (`PAYLOAD_TOO_LARGE`), never truncated silently.
- `classification` — one of `PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED, SECRET_REFERENCE`. Metadata only in v0.1 — no enforcement, no DLP.
- `retention` — `{ retention_class, retain_until?, legal_hold }`. Metadata only; v0.1 does not implement deletion.

## Context blocks

- **authority_context** (Gate-derived): `agent_id, decision_id, policy_hash, policy_issuance_id, approval_id, capability_id, action, tool, resource, operation, destination, authority_expiry`.
- **spec_context** (VAD-derived): `atom_id, atom_version, spec_hash, risk_level, success_criterion_ids, attempt_number, validation_run_id, verifier_id, verifier_verdict, human_decision`.
- **execution_context**: `execution_id, tool, operation, resource, input_hash, started_at, completed_at, runtime_ms, exit_status, termination_reason, result_hash`.
- **artifact_context**: `artifact_id, artifact_type, artifact_hash, diff_hash, manifest_hash, storage_reference`.

None of these are full schemas with every field mandatory — each is a bag of optional, individually-typed fields. What IS mandatory is enforced per event type by completeness rules below.

## Completeness rules (section 61)

A "successful" event without its provenance is rejected outright, not accepted with a warning:

| Event type | Required |
|---|---|
| `AUTHORIZATION_ALLOWED` | `authority_context.{decision_id, agent_id, policy_hash, action}` |
| `CAPABILITY_ISSUED` | `authority_context.{capability_id, decision_id, authority_expiry}` |
| `CAPABILITY_REDEEMED` | `authority_context.capability_id` |
| `EXECUTION_STARTED` | `execution_context.execution_id` |
| `EXECUTION_SUCCEEDED` | `execution_context.{execution_id, result_hash}` |
| `EXECUTION_FAILED/TERMINATED/INDETERMINATE` | `execution_context.execution_id` |
| `ATOM_CREATED` | `spec_context.{atom_id, spec_hash}` |
| `ATOM_ACCEPTED` | `spec_context.{atom_id, spec_hash, verifier_verdict, human_decision}`, `artifact_context.artifact_hash` |
| `AGENT_REVOKED` | `authority_context.agent_id` |

Cross-event invariants (a prior causal event must actually exist) are a separate, stronger check — see `ledger-integrity-model-v1.md` §cross-event invariants.

## Event types (v1.0 registry)

```
AGENT_REGISTERED
AUTHORIZATION_REQUESTED, AUTHORIZATION_ALLOWED, AUTHORIZATION_BLOCKED, AUTHORIZATION_HELD
APPROVAL_GRANTED, APPROVAL_REJECTED, APPROVAL_EXPIRED
CAPABILITY_ISSUED, CAPABILITY_REDEEMED, CAPABILITY_REJECTED
EXECUTION_STARTED, EXECUTION_SUCCEEDED, EXECUTION_FAILED, EXECUTION_TERMINATED, EXECUTION_INDETERMINATE
ATOM_CREATED, ATOM_STARTED, ATOM_ATTEMPT_STARTED, ATOM_ATTEMPT_FAILED, ATOM_VALIDATION_PASSED, ATOM_VALIDATION_FAILED
ATOM_VERIFICATION_ACCEPTED, ATOM_VERIFICATION_REJECTED, ATOM_HUMAN_DECISION, ATOM_ACCEPTED, ATOM_REJECTED, ATOM_ESCALATED
POLICY_ISSUED, POLICY_REPLACED, AGENT_REVOKED
INTEGRITY_CHECK_PASSED, INTEGRITY_CHECK_FAILED
```

There is no extension mechanism in v0.1 — adding a new event type requires a code change to the registry, not a runtime declaration. `ATOM_STARTED`, `POLICY_ISSUED`, `POLICY_REPLACED`, `AUTHORIZATION_REQUESTED/HELD`, `APPROVAL_*`, `INTEGRITY_CHECK_*` are defined in the registry and pass validation, but no adapter in apps/tna-ledger currently emits them — PARTIAL, reserved for the corresponding Gate/VAD evidence to be wired up in a later milestone.

## Secret rejection

`findSecretShapedField` recursively scans `payload` and every context block for:

- key names matching `api_key, apikey, secret, password, private_key, access_token, refresh_token, client_secret, bearer, authorization` (case-insensitive, `_`/`-` insensitive), and
- string values matching a bearer-token shape (`Bearer <token>`, anywhere in the string).

A match is a hard `INVALID_EVENT` rejection, not a redaction or a hash-and-store. This is a fixed, documented rule set — not general secret detection (see `ledger-threat-model-v0.1.md`).

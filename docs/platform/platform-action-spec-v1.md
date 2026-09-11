# TNA Platform Action Spec v1.0

## `PlatformActionRequest` (caller-supplied, section 6)

```ts
interface PlatformActionRequestInput {
  version: '1.0';
  request_id: string;               // caller-chosen, for idempotency (section 93)
  tenant_id: string; agent_id: string;
  action: string; tool: string; operation: string; resource: string;
  input: Record<string, unknown>;   // bounded, secret-scanned
  requested_runtime_limits?: { max_runtime_seconds: number };
  requested_cost_limits?: { max_cost_usd: number };
  requires_verification: boolean;
  verification_spec_id?: string;
  metadata?: Record<string, unknown>;
}
```

`validatePlatformActionRequestInput` (`packages/platform-schema`) rejects any unknown top-level field
outright (not silently drops it — an abuse attempt fails loudly) and additionally rejects an explicit
list of runtime-owned field names (`platform_action_id`, `decision_id`, `capability_id`,
`sentinel_session_id`, `execution_id`, `status`, `state_version`, `result`, `result_hash`,
`sentinel_decision`, `vad_result`, `vad_final_state`, `ledger_hash`, `ledger_event_id`,
`audit_result`, `evidence_status`, `input_hash`, `created_at`, `created_by`) even if it were
otherwise a known field name — a caller cannot forge any of these by construction, not by convention.

## Runtime-owned identity (section 7)

```ts
interface PlatformActionIdentity {
  platform_action_id: string;   // pa_<uuid>
  correlation_id: string;       // corr_<uuid> — shared across Gate/Sentinel/VAD/Ledger for this action
  created_at: string; created_by: string;
  input_hash: string;           // hash(tool, operation, resource, input) — section 19 binding
}
```

Both ids are assigned once, at `RECEIVED`, by `PlatformStore.createOrReturn` — never by the caller.

## `input_hash` (section 19)

`computeInputHash({tool, operation, resource, input})` covers exactly the binding that must not
drift between authorization and execution. It is computed once at `RECEIVED` and re-verified
immediately before every broker-mediated redemption; a mismatch (structurally unreachable through the
public API, since the stored request is immutable once written, but defensively checked and proven by
a white-box test) blocks the connector call entirely rather than letting a stale binding through.

## `PlatformAction` (persisted, returned to callers)

Extends the identity above with `tenant_id`, `request`, `state`, `state_version`, `updated_at`,
`gate_decision`, `capability_id`, `sentinel_session_id`, `execution_id`, `result_hash`,
`vad_atom_id`, `vad_final_state`, `error_code`, `error_message` — every one of these fields is
runtime-written only, through `PlatformStore`'s own CAS-protected methods (see
`platform-state-machine-v0.1.md`).

## Idempotency (section 93)

`(tenant_id, request_id)` is a unique constraint. The same `request_id` with an identical canonical
request returns the existing action (a true idempotent replay, including under genuine concurrent
submission — proven in `platform-races.test.ts`). The same `request_id` with different content is
`CONFLICT`.

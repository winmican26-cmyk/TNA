# TNA Client Integration v0.1 — Tool Policy Binding

## Purpose (§33–34)

A `ToolPolicyBinding` captures the complete policy decision made at the moment an operator enables a
governed tool. It is the durable record of *why* and *under what constraints* a tool was enabled,
including the tool's schema hash at the time of binding — so a later schema change cannot inherit
trust from a policy that was evaluated against a different schema.

## The ToolPolicyBinding type

```typescript
interface ToolPolicyBinding {
  readonly binding_id: string;              // `bind_<uuid>`
  readonly tenant_id: string;
  readonly tool_id: string;
  readonly policy_id: string;              // the policy applied
  readonly policy_hash: string;            // SHA-256 of the complete policy decision
  readonly risk_class: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly approval_mode: 'none' | 'human_approval';
  readonly runtime_limits: Readonly<Record<string, unknown>>;
  readonly cost_limits: Readonly<Record<string, unknown>>;
  readonly verification_requirement: 'none' | 'vad';
  readonly bound_at: string;               // ISO 8601
  readonly bound_by: string;               // the operator principal
}
```

## Binding at enable time (§33)

A `ToolPolicyBinding` is created in the same transaction as `enableTool`. The binding captures:

1. **policy_id** — the policy that was applied
2. **policy_hash** — `SHA-256` of `{ policy_id, risk_class, approval_mode, runtime_limits,
   cost_limits, verification_requirement, schema_hash }` — a content-addressable digest of the
   entire policy decision *including* the tool's current schema
3. **risk_class** — from the deterministic classification table
4. **approval_mode** — whether the tool requires human approval per invocation
5. **runtime_limits** — operator-defined execution constraints
6. **cost_limits** — operator-defined cost constraints
7. **verification_requirement** — whether VAD verification is required
8. **bound_by** — the operator principal who made the decision
9. **bound_at** — the timestamp of the decision

## Schema hash inclusion in policy_hash (§34)

The `policy_hash` includes the tool's `schema_hash` at the time of binding. This means:

- If the tool's schema drifts (detected by a subsequent discovery), the tool's current `schema_hash`
  will no longer match the hash bound in the policy
- This is exactly what triggers `POLICY_REVIEW_REQUIRED` — the policy was evaluated against a schema
  that no longer matches reality
- A re-review must produce a new `ToolPolicyBinding` against the new schema

## Policy drift handling

Policy drift occurs when any component of the bound policy no longer matches the tool's current
state. The primary trigger is schema drift (detected by discovery reconciliation), which:

1. Sets `review_status` to `POLICY_REVIEW_REQUIRED`
2. Disables the tool (`enabled: false`)
3. Invalidates the prior policy binding's applicability

The operator must then:
1. Review the new schema
2. Re-classify risk if the schema change warrants it
3. Create a new `enableTool` call, which creates a new `ToolPolicyBinding`

The old binding is never deleted — it remains in the `tool_policy_bindings` table as historical
evidence of the prior decision. `listPolicyBindings(tenantId, toolId)` returns all bindings ordered
by `bound_at`, providing a full audit trail of every policy decision for this tool.

## Multiple bindings

A tool accumulates policy bindings over time. Each re-enablement (after drift, after disable, after
re-review) creates a new binding. The bindings table is append-only — no binding is ever updated or
deleted.

This means an auditor can reconstruct: "This tool was first enabled under policy X on date A, then
its schema drifted on date B, and it was re-enabled under policy Y on date C."

## Storage

`tool_policy_bindings` table with an index on `(tenant_id, tool_id, bound_at)` for efficient
per-tool binding history queries.

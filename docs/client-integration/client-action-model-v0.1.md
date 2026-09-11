# TNA Client Integration v0.1 — Client Action Model

## Purpose (§35, §40–42, §49)

A `ClientActionRecord` captures the context of a client-initiated action at the moment of submission,
before the action enters the platform's orchestration pipeline. It binds the action to a specific
tenant, service identity, MCP server, governed tool, and a configuration snapshot — so the action's
provenance and the state of the world at submission time are always reconstructible.

## The ClientActionRecord type

```typescript
interface ClientActionRecord {
  readonly tenant_id: string;
  readonly client_action_id: string;     // unique action identifier
  readonly service_id: string;           // the authenticated service identity
  readonly mcp_server_id: string | null; // the MCP server, if applicable
  readonly governed_tool_id: string | null; // the governed tool, if applicable
  readonly config_snapshot_hash: string; // SHA-256 of the integration config at submission
  readonly created_at: string;           // ISO 8601
}
```

## Action flow through the platform (§35, §40)

```
1. Client authenticates (bearer token → service identity → tenant_id + role)
2. Tenant eligibility checked (must be ACTIVE)
3. Configuration snapshot computed (computeIntegrationConfigHash)
4. ClientActionRecord created (recordClientAction)
5. PlatformActionRequest submitted to the platform orchestration pipeline
6. Platform orchestrates: Gate → Capability → Sentinel → MCP Gateway → Tool
```

The client action record is the *pre-platform* record. It exists to prove what the integration layer
knew at submission time — the platform's own `PlatformAction` record captures what happened *during*
orchestration.

## Input binding (§41)

When a client action targets a governed tool, the action's input is validated against the tool's
current schema and bound to the action before it enters the platform. The input binding includes:

- The `governed_tool_id` (UUID-based, not name-based)
- The tool's current `schema_hash` (verified against the policy binding)
- The input data itself (flows to the platform as the `PlatformActionRequest.input`)

If the tool's `schema_hash` has drifted since its last policy binding, the action is rejected before
submission — the client receives `SCHEMA_DRIFT_DETECTED`, not a downstream failure.

## Configuration snapshot (§42, §49)

`computeIntegrationConfigHash(tenantId)` produces a SHA-256 hash of:

```typescript
{
  tenant_id,
  tenant_config_hash,         // the tenant's own configuration_hash
  services: [{ service_id, role, status }],  // all service identities
  servers: [{ mcp_server_id, config_hash, status }],  // all MCP servers
  tools: [{ tool_id, enabled, schema_hash, risk_class, review_status }]
}
```

This snapshot is computed once, at submission time, and stored in `config_snapshot_hash`. A later
configuration change (new service identity, MCP server reconfiguration, tool drift) does not
retroactively change what the already-recorded action saw.

## Idempotency (§49)

The `client_actions` table has a composite primary key `(tenant_id, client_action_id)`. A duplicate
submission with the same `client_action_id` for the same tenant will fail with a primary-key
violation — the caller must use a unique action id per submission.

## Tenant eligibility

`assertActionEligible(tenantId)` checks that the tenant's status is exactly `ACTIVE`. If the tenant
is `PENDING`, `SUSPENDED`, `OFFBOARDING`, or `OFFBOARDED`, the action is rejected with
`TENANT_NOT_ACTIVE` before any downstream work occurs.

## Relationship to the platform

The `ClientActionRecord` is this layer's record. The platform's `PlatformAction` is the platform's
record. They are linked by the action id but are independently durable — the client integration
layer's snapshot exists even if the platform action fails at any stage.

## What this model does NOT include

- **Execution result.** That lives in the platform's `PlatformAction` record.
- **Gate/Sentinel decisions.** Those are platform-level concerns.
- **Ledger evidence.** That is recorded by the platform's outbox.
- **MCP server response.** The gateway returns it to the platform, not to this layer.

This separation is by design: the client action model captures *intent and context at submission*;
the platform captures *execution and evidence*.

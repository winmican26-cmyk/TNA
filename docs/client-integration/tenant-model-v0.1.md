# TNA Client Integration v0.1 — Tenant Model

## Purpose

A `ClientTenant` is the top-level identity for an external client organization within TNA's client
integration control plane. Every service identity, MCP server registration, governed tool, and policy
binding is scoped to exactly one tenant. There is no method anywhere in `ClientStore` that accepts an
unscoped identifier and returns cross-tenant data (§38).

## The ClientTenant type (§4–5)

```typescript
interface ClientTenant {
  readonly tenant_id: string;             // runtime-owned, `ten_<uuid>`
  readonly display_name: string;          // operator-supplied, bounded (≤200 chars)
  readonly environment: 'development' | 'test' | 'production';
  readonly status: ClientTenantStatus;    // runtime-owned
  readonly created_at: string;            // runtime-owned, ISO 8601
  readonly created_by: string;            // the principal who created the tenant
  readonly deployment_binding: string;    // safe identifier
  readonly policy_profile: string;        // safe identifier
  readonly allowed_connector_types: readonly ('mcp-stdio')[];
  readonly configuration_hash: string;    // runtime-computed, SHA-256
  readonly state_version: number;         // CAS version counter
  readonly suspended_reason: string | null;
  readonly offboarding_reason: string | null;
}
```

## Runtime-owned identity (§5)

`tenant_id` is never caller-supplied. The platform mints it at creation time as `ten_<uuid>`. Every
subsequent operation uses this as the scoping key. A caller cannot choose or predict a tenant id —
this is the same discipline the platform's own `platform_action_id` follows.

## Tenant statuses and lifecycle (§4–5, §10)

```
PENDING → ACTIVE → SUSPENDED → ACTIVE (resume)
                 → OFFBOARDING → OFFBOARDED
ACTIVE → OFFBOARDING → OFFBOARDED
SUSPENDED → OFFBOARDING → OFFBOARDED
```

| Status | Meaning | Allowed operations |
|---|---|---|
| `PENDING` | Tenant created, onboarding in progress | Service identity creation, MCP registration, tool discovery — but no consequential actions through the platform |
| `ACTIVE` | Fully operational | All operations including consequential actions |
| `SUSPENDED` | Temporarily disabled | No new actions, no new service identities; existing data preserved for possible resume |
| `OFFBOARDING` | Offboarding cascade in progress | No new actions; service identities revoked, tools disabled, MCP servers disabled — all in one transaction (§9, §52) |
| `OFFBOARDED` | Terminal state | Read-only; historical evidence preserved, never deleted (§9) |

## Allowed transitions

Every transition is CAS-protected via `state_version`. The `transitionTenant` method in `ClientStore`
checks both the current status (must be in `allowedFrom`) and the exact `state_version` (must match)
before any write.

| From | To | Method | Actor |
|---|---|---|---|
| PENDING | ACTIVE | `activateTenant()` | operator |
| ACTIVE | SUSPENDED | `suspendTenant(reason)` | operator |
| SUSPENDED | ACTIVE | `resumeTenant()` | operator |
| ACTIVE, SUSPENDED | OFFBOARDING | `beginOffboarding(reason, actor)` | operator |
| OFFBOARDING | OFFBOARDED | `completeOffboarding()` | operator |

No transition from `OFFBOARDED` to any other status exists. No transition skips a step — an `ACTIVE`
tenant cannot jump to `OFFBOARDED` without passing through `OFFBOARDING`.

## Configuration hash (§10)

`configuration_hash` is a SHA-256 hash of the tenant's own configuration fields (display_name,
environment, deployment_binding, policy_profile, allowed_connector_types), computed at creation time.
This hash participates in the integration-config snapshot (`computeIntegrationConfigHash`) bound into
every client action — so a retroactive configuration change cannot rewrite what an already-recorded
action saw.

## Tenant isolation (§38)

Every `ClientStore` query is `(tenant_id, ...)`-scoped. The SQL schema uses composite primary keys
and indexed foreign-key-like columns that always include `tenant_id`. There is no `SELECT` anywhere
in `ClientStore` that does not filter by tenant.

## Validation (§4)

`validateClientTenantCreateInput` enforces:
- `display_name`: non-empty, bounded (≤200 chars)
- `environment`: closed union — exactly `development`, `test`, or `production`
- `deployment_binding`, `policy_profile`: safe identifiers (alphanumeric + `.`, `_`, `:`, `-`)
- `allowed_connector_types`: non-empty array, only `mcp-stdio` in v0.1
- No unknown fields
- No secret-shaped fields (`findSecretShapedField` applied before persistence)

## Suspension semantics

`suspendTenant` requires a reason string. While suspended:
- `assertActionEligible()` throws `TENANT_NOT_ACTIVE` for any new consequential action
- `assertActionEligible2()` (used by service-identity/MCP-registration methods) also refuses
- The reason is preserved in `suspended_reason` and cleared on resume

## Offboarding cascade (§9, §52)

`beginOffboarding` performs a transactional cascade in one `BEGIN IMMEDIATE` block:
1. Transitions the tenant to `OFFBOARDING`
2. Revokes all `ACTIVE` service identities (→ `REVOKED`)
3. Disables all enabled governed tools (→ `DISABLED`)
4. Disables all non-disabled MCP servers (→ `DISABLED`)

Historical data — rows in every table, and all Ledger evidence ever recorded for this tenant — is
never deleted. The offboarding cascade prevents *future* use of these resources but does not destroy
the evidence that past use occurred.

## CAS discipline

Every mutation uses `UPDATE ... WHERE state_version = ?`. If the row's version has moved (another
writer won the race), the `changes` count is 0 and a `CONFLICT` error is raised, requiring the
caller to re-read and retry — the same TNA-33 discipline every prior volume's durable store applies.

## Storage

SQLite with WAL mode, `PRAGMA synchronous=FULL`, `PRAGMA busy_timeout=8000`. The
`client_tenants` table is the sole durable home of tenant state — no in-memory cache, no
eventually-consistent replica.

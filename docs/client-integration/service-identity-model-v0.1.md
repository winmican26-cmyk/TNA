# TNA Client Integration v0.1 — Service Identity Model

## Purpose (§6)

A `ClientServiceIdentity` represents a named, credentialed participant within a tenant — an agent
client, a tool provider, an operator, or a read-only auditor. Every authenticated request resolves to
exactly one service identity, and that identity's `tenant_id` and `role` are the sole source of
authority for the request — a caller-supplied tenant_id in a request body is never trusted (§37).

## The ClientServiceIdentity type (§6–8)

```typescript
interface ClientServiceIdentity {
  readonly service_id: string;           // runtime-owned, `svc_<uuid>`
  readonly tenant_id: string;            // the tenant this identity belongs to
  readonly name: string;                 // operator-supplied, bounded (≤200 chars)
  readonly role: ClientServiceRole;      // closed union — see below
  readonly status: ClientServiceStatus;  // ACTIVE | REVOKED
  readonly credential_ref: string;       // opaque reference, `cred_<uuid>`
  readonly created_at: string;           // ISO 8601
  readonly last_rotated_at: string;      // ISO 8601, updated on rotation
  readonly state_version: number;        // CAS version counter
}
```

Note: the bearer token itself and its verification hash are *not* fields of the public type. The hash
is stored in the database column `credential_hash` but is never surfaced through `getServiceIdentity`
or `listServiceIdentities` — it exists only for `authenticateService`.

## Roles (§6, §55)

```typescript
const CLIENT_SERVICE_ROLES = ['agent-client', 'tool-provider', 'operator', 'read-only-auditor'] as const;
```

| Role | Purpose |
|---|---|
| `agent-client` | The external agent system that submits actions through the platform |
| `tool-provider` | A service that provides/manages MCP servers for this tenant |
| `operator` | Trusted human or automation with administrative privileges (enable tools, manage lifecycle) |
| `read-only-auditor` | Can read state and evidence but cannot mutate anything |

The role set is a closed union, not an arbitrary string. Validation rejects any value outside this
list.

## Service identity statuses

| Status | Meaning |
|---|---|
| `ACTIVE` | The identity's credential is valid; requests authenticated against it are processed |
| `REVOKED` | The identity is permanently deactivated; authentication always fails |

There is no `SUSPENDED` status for service identities — suspension is a tenant-level concept. When a
tenant is suspended, `assertActionEligible2()` refuses new consequential operations for all of its
service identities regardless of their individual `ACTIVE` status.

## Lifecycle

### Creation

`createServiceIdentity(tenantId, input, createdBy)`:
1. Verifies the tenant is eligible (`assertActionEligible2` — PENDING or ACTIVE, not SUSPENDED/
   OFFBOARDING/OFFBOARDED)
2. Generates a `svc_<uuid>` service id
3. Issues a fresh credential (see `credential-lifecycle-v0.1.md`)
4. Stores the credential's SHA-256 hash in the `credential_hash` column — never the raw token
5. Returns both the identity and the credential (the only time the raw token is returned)

### Rotation (§56)

`rotateCredential(tenantId, serviceId, expectedVersion)`:
1. Verifies the identity is `ACTIVE` (revoked identities cannot rotate)
2. CAS check on `state_version`
3. Issues a new credential
4. Atomically replaces the old `credential_hash` and `credential_ref` with the new ones
5. Updates `last_rotated_at`
6. Returns the new credential — the only time the new raw token is returned

Rotation is atomic: the old credential's hash stops matching any row in the same instant the new one
starts matching, with no dual-valid window (§56).

### Revocation

`revokeServiceIdentity(tenantId, serviceId, expectedVersion)`:
- CAS-protected transition to `REVOKED`
- Permanent — no method reverses revocation
- The identity's row is preserved for historical evidence

### Offboarding cascade

When `beginOffboarding` is called on the parent tenant, all `ACTIVE` service identities under that
tenant are revoked in the same transaction — a bulk `UPDATE` within the tenant-scoped offboarding
cascade.

## Authentication (§37)

`authenticateService(token)`:
1. Computes `SHA-256(token)` → `hashHex`
2. Looks up `credential_hash = hashHex` in the `client_service_identities` table
3. If no row matches, returns `null`
4. If the row's `status` is not `ACTIVE`, returns `null`
5. Performs a constant-time-ish verification (`verifyCredentialToken`) — both sides are fixed-length
   hex digests, so comparison does not leak timing information proportional to a secret's content
6. Returns the `ClientServiceIdentity` — the caller uses its `tenant_id` and `role` as authority

A caller-supplied `tenant_id` in a request body is never trusted. The authenticated identity's own
`tenant_id` is the sole scoping key for all subsequent operations.

## Validation

`validateServiceIdentityCreateInput` enforces:
- `name`: non-empty, bounded (≤200 chars)
- `role`: must be one of the closed union values
- No unknown fields

## Tenant scoping

Every query (`getServiceIdentity`, `listServiceIdentities`) requires `tenantId` as the first
parameter. The SQL is `WHERE tenant_id=? AND service_id=?`. A service identity from one tenant is
never visible to another tenant's queries.

## CAS discipline

All mutable operations (rotation, revocation) use `UPDATE ... WHERE state_version=?` and check
`changes === 1`. A concurrent modification raises `CONFLICT`.

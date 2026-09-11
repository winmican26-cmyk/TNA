# TNA Client Integration v0.1 — Client Offboarding Runbook

This runbook covers the full offboarding procedure for a client tenant. Written for an operator who
did not build TNA.

## When to offboard

Offboard a tenant when the client organization is leaving, the integration is being decommissioned, or
a security incident requires immediate revocation of all access.

## Prerequisites

- Operator-level credentials for the TNA instance
- The `tenant_id` and current `state_version` of the tenant to offboard
- A documented reason for the offboarding

## Step 1: Suspend (if not already suspended)

If the tenant is currently `ACTIVE`, suspend it first to stop new actions while you prepare:

```
POST /v1/clients/tenants/{tenant_id}/suspend
{
  "expected_version": <current state_version>,
  "reason": "Preparing for offboarding — client contract ended"
}
```

This immediately prevents new consequential actions. Existing in-flight actions (if any) will
complete or time out through the platform's own lifecycle.

**In an emergency**, skip directly to Step 2 — `beginOffboarding` accepts both `ACTIVE` and
`SUSPENDED` as starting states.

## Step 2: Begin offboarding cascade

```
POST /v1/clients/tenants/{tenant_id}/offboard
{
  "expected_version": <current state_version>,
  "reason": "Client contract ended — offboarding per procedure",
  "actor": "operator:jane@example.com"
}
```

This performs the full cascade in one atomic transaction:
- Tenant status → `OFFBOARDING`
- All `ACTIVE` service identities → `REVOKED`
- All enabled governed tools → `DISABLED`
- All non-disabled MCP servers → `DISABLED`

**After this step:**
- No credential for this tenant can authenticate
- No tool for this tenant can be invoked
- No MCP server for this tenant will be spawned
- No new actions for this tenant will be accepted

## Step 3: Verify cascade completion

```
GET /v1/clients/tenants/{tenant_id}
GET /v1/clients/tenants/{tenant_id}/service-identities
GET /v1/clients/tenants/{tenant_id}/mcp-servers
GET /v1/clients/tenants/{tenant_id}/tools
```

Verify:
- Tenant status is `OFFBOARDING`
- All service identities show `status: 'REVOKED'`
- All MCP servers show `status: 'DISABLED'`
- All tools show `enabled: false`

## Step 4: Evidence preservation

Historical data is never deleted by offboarding (§9):

- **ClientStore records** — tenant, service identities, MCP servers, governed tools, policy bindings,
  client action records — all remain in the database as historical evidence
- **Ledger evidence** — all events ever recorded for this tenant remain in the Ledger
- **Auditor assessments** — if any were performed, they remain intact

Do NOT manually delete database rows or Ledger entries. The evidence must remain for post-hoc audit.

If you need to export the evidence for the client organization or for an external audit:
- Query the Ledger for all events scoped to this tenant
- Export the client action records
- Export the policy binding history
- Include the tenant's configuration at the time of offboarding

## Step 5: Complete offboarding

Once you have verified the cascade and preserved any needed evidence:

```
POST /v1/clients/tenants/{tenant_id}/complete-offboarding
{ "expected_version": <current state_version> }
```

The tenant moves to `OFFBOARDED` — a terminal state. No transition from `OFFBOARDED` to any other
status exists.

## Post-offboarding

- The tenant's data remains queryable (read-only) for audit purposes
- No new actions, service identities, or MCP registrations can be created
- The tenant id is never reused (UUID-based)
- Remove any client-side configuration that references this tenant's credentials

## Emergency offboarding

For a security incident requiring immediate revocation:

1. Skip the suspend step
2. Call `beginOffboarding` directly on the `ACTIVE` tenant
3. The cascade revokes all credentials in the same transaction
4. Investigate the incident
5. Complete offboarding once the investigation is finished

The cascade is atomic — there is no window between "offboarding started" and "credentials revoked"
where an attacker could use a credential that should have been revoked.

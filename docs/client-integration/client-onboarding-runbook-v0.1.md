# TNA Client Integration v0.1 — Client Onboarding Runbook

This runbook is written for someone who did not build TNA. Every step below operates against the
client integration control plane as implemented in Volume 10.

## Prerequisites

- TNA deployment is running and healthy (`/ready` returns 200)
- You have operator-level credentials for the TNA instance
- The client organization has provided: their MCP server binary/script path, expected arguments,
  and any environment variables the server needs

## Step 1: Create tenant

Create a `ClientTenant` for the client organization:

```
POST /v1/clients/tenants
{
  "display_name": "Acme Corp CRM Integration",
  "environment": "production",
  "deployment_binding": "acme-prod-01",
  "policy_profile": "standard-v1",
  "allowed_connector_types": ["mcp-stdio"]
}
```

The response includes a `tenant_id` (`ten_<uuid>`) — all subsequent operations use this id.
The tenant starts in `PENDING` status.

## Step 2: Create service identity

Create a service identity for the client's agent system:

```
POST /v1/clients/tenants/{tenant_id}/service-identities
{
  "name": "acme-agent-client",
  "role": "agent-client"
}
```

**Save the returned `token` immediately.** It is returned exactly once and is never retrievable
again. This is the bearer token the client will use to authenticate.

Create additional identities as needed (e.g., `operator` for management, `read-only-auditor` for
monitoring).

## Step 3: Register MCP server

Register the client's MCP server:

```
POST /v1/clients/tenants/{tenant_id}/mcp-servers
{
  "name": "Acme CRM Server",
  "transport": "stdio",
  "executable": "/opt/acme/mcp-crm-server",
  "args": ["--config", "/opt/acme/crm.json"],
  "env_allowlist": ["CRM_API_KEY"],
  "credential_ref": null
}
```

**Review the executable path and arguments carefully.** This is the binary TNA will spawn. Verify it
is the correct, expected binary — TNA does not verify binary identity beyond what the OS provides.

The server starts in `REGISTERED` status.

## Step 4: Discover tools

Trigger tool discovery for the registered server:

```
POST /v1/clients/tenants/{tenant_id}/mcp-servers/{mcp_server_id}/discover
```

This spawns the MCP server, performs the protocol handshake, calls `tools/list`, reconciles the
result, and shuts down the server. New tools appear with `review_status: 'DISCOVERED'`.

Verify the discovered tools match expectations:

```
GET /v1/clients/tenants/{tenant_id}/tools?server_id={mcp_server_id}
```

## Step 5: Review each tool

For each discovered tool, review:
- Its `external_tool_name` and `description`
- Its `input_schema` — what parameters it accepts
- What it actually does (consult the client's documentation, not just the MCP description)

## Step 6: Classify risk

For each tool, determine the risk classification inputs:
- **operation**: `read`, `write`, or `execute`?
- **network_required**: does the tool make network calls?
- **category**: `general`, `financial`, `credential-mutation`, `code-execution`, `filesystem-write`,
  or `deployment`?

Apply the classification table (see `tool-risk-model-v0.1.md`) to determine the risk class.

## Step 7: Bind policy and enable

For each reviewed tool:

```
POST /v1/clients/tenants/{tenant_id}/tools/{tool_id}/enable
{
  "risk_class": "MEDIUM",
  "allowed_operations": ["crm.read"],
  "resource_patterns": ["crm/customers/*"],
  "requires_human_approval": false,
  "requires_vad": false,
  "policy_id": "standard-crm-read-v1",
  "runtime_limits": { "max_calls_per_session": 100 },
  "cost_limits": { "max_cost_per_call": 0.10 },
  "bound_by": "operator:jane@acme.com"
}
```

This creates a `ToolPolicyBinding` and sets the tool to `ENABLED`.

## Step 8: Test with a non-production action

Submit a test action through the client integration layer and verify it flows through the full
pipeline: authentication → tenant eligibility → config snapshot → platform submission → Gate →
Sentinel → MCP Gateway → Tool → result.

## Step 9: Activate tenant

```
POST /v1/clients/tenants/{tenant_id}/activate
{ "expected_version": <current state_version> }
```

The tenant moves from `PENDING` to `ACTIVE`. Consequential actions are now accepted.

## Step 10: Verify readiness

Confirm the onboarding readiness assessment (see `onboarding-readiness-v0.1.md`). Address any
`NOT_READY` items before allowing production traffic.

## Post-onboarding

- **Monitor** the MCP server's status — periodic rediscovery will detect schema drift or tool
  removal.
- **Rotate credentials** on a regular schedule (see `credential-lifecycle-v0.1.md`).
- **Review drift** promptly — a `POLICY_REVIEW_REQUIRED` tool is not executable until re-reviewed.
- **Document** the onboarding decision and the operator's reasoning for each tool's risk
  classification and policy binding.

# TNA Client Integration v0.1 — MCP Operations Runbook

This runbook covers the operational lifecycle of MCP servers within a tenant's client integration.
Written for an operator who did not build TNA.

## 1. Register an MCP server

```
POST /v1/clients/tenants/{tenant_id}/mcp-servers
{
  "name": "CRM Server",
  "transport": "stdio",
  "executable": "/opt/crm/mcp-server",
  "args": ["--port", "0"],
  "env_allowlist": ["CRM_DB_HOST"],
  "credential_ref": null
}
```

Validation rejects: shell command strings, arguments with shell metacharacters, non-uppercase env
names, executables with spaces or special characters. The server starts as `REGISTERED`.

## 2. Discover tools

```
POST /v1/clients/tenants/{tenant_id}/mcp-servers/{mcp_server_id}/discover
```

The gateway spawns the MCP server, performs the handshake, lists tools, reconciles, and shuts down.
On success, the server moves to `REACHABLE` and new tools appear as `DISCOVERED`.

## 3. Review discovered tools

```
GET /v1/clients/tenants/{tenant_id}/tools?server_id={mcp_server_id}
```

For each `DISCOVERED` tool, review the `external_tool_name`, `description`, and `input_schema`.
Determine the risk classification inputs and apply the classification table.

## 4. Enable tools

```
POST /v1/clients/tenants/{tenant_id}/tools/{tool_id}/enable
{ ... risk_class, policy_id, etc. ... }
```

Only enabled tools are executable. See `client-onboarding-runbook-v0.1.md` Step 7 for the full
enable payload.

## 5. Rotate credential

If the MCP server's credential needs rotation:

```
POST /v1/clients/tenants/{tenant_id}/service-identities/{service_id}/rotate
{ "expected_version": <current state_version> }
```

The old credential immediately stops working. Update the MCP server's `credential_ref` if it binds
to a service identity credential. Note: there is no dual-valid window — coordinate rotation timing
with the client.

## 6. Rediscover (periodic or on-demand)

```
POST /v1/clients/tenants/{tenant_id}/mcp-servers/{mcp_server_id}/discover
```

Rediscovery detects:
- **New tools** → `DISCOVERED` (not auto-enabled)
- **Schema drift** → `POLICY_REVIEW_REQUIRED` (tool disabled, requires re-review)
- **Removed tools** → `REMOVED` (tool disabled)

Run rediscovery periodically (e.g., daily) or on-demand when the client reports server changes.

## 7. Handle schema drift

When rediscovery detects drift:

1. Review the drifted tool's new `input_schema`
2. Determine if the risk classification still applies
3. Re-enable with a new policy binding:
   ```
   POST /v1/clients/tenants/{tenant_id}/tools/{tool_id}/enable
   { ... updated risk_class, policy ... }
   ```

Drifted tools remain disabled until re-reviewed. Do not skip this step.

## 8. Disable a tool

```
POST /v1/clients/tenants/{tenant_id}/tools/{tool_id}/disable
{ "expected_version": <current state_version> }
```

The tool moves to `DISABLED` and is immediately ineligible for execution. This is reversible — the
tool can be re-enabled via `enableTool` after re-review.

## 9. Troubleshoot

### Server won't start (MCP_SERVER_UNAVAILABLE)
- Verify the executable path exists and is executable
- Verify the arguments are correct
- Check the server's stderr output (captured in error messages)

### Server hangs (MCP_TIMEOUT)
- The gateway enforces bounded timeouts (5s startup, 10s discovery, 30s call, 3s shutdown)
- A hanging server is killed (SIGTERM → SIGKILL)
- Check the server for deadlocks or resource exhaustion

### Protocol errors (MCP_PROTOCOL_ERROR)
- The server sent non-JSON data, or a response without the expected structure
- Verify the server speaks MCP's JSON-RPC 2.0 stdio protocol

### Server crashes during call (MCP_INDETERMINATE)
- The outcome is genuinely unknown — TNA does not guess
- Investigate the server's crash cause before retrying
- The tool call may or may not have had side effects

### Schema drift after server update
- Expected after the client updates their MCP server
- Run rediscovery, review the new schemas, re-enable as appropriate

## 10. Remove an MCP server

To fully remove an MCP server and its tools:

1. Disable all tools associated with the server:
   ```
   GET /v1/clients/tenants/{tenant_id}/tools?server_id={mcp_server_id}
   # For each enabled tool:
   POST /v1/clients/tenants/{tenant_id}/tools/{tool_id}/disable
   ```

2. Disable the server:
   ```
   POST /v1/clients/tenants/{tenant_id}/mcp-servers/{mcp_server_id}/status
   { "status": "DISABLED", "expected_version": <current> }
   ```

Historical records (tool registrations, policy bindings, action records) are preserved. Removal is a
status change, not a deletion.

# TNA Platform — MCP Boundary v0.1

## Status: boundary interface only, not implemented (sections 59-63, explicitly optional)

Section 59 marks MCP support "optional but preferred," and section 60's minimum bar ("if implemented")
requires a working local MCP server fixture proving tool discovery through Gate/capability/Sentinel/
Ledger end to end. Given this milestone's already-large scope, v0.1 ships only the narrow adapter
**type boundary** — no MCP client, no transport, no local server fixture:

```ts
interface McpToolConnector extends ToolConnector {
  readonly mcp_server_id: string;
  readonly mcp_tool_name: string;
}
```

This is a deliberate scope decision, not a silent gap. Building a half-working MCP integration would
be worse than declaring the boundary and stopping: a narrow, honest interface that a future milestone
can implement against, versus a partially-wired surface that looks more complete than it is.

## Why this shape

`McpToolConnector` is, structurally, still just a `ToolConnector` (see
`platform-connector-model-v0.1.md`). Declaring it as an extension rather than a parallel type makes
the non-negotiable constraint explicit by construction (section 61): **an MCP-exposed tool receives no
special trust merely for being MCP.** Whenever this is implemented, it must still flow through the
exact same `ConnectorRegistry` → `buildToolRegistry` → `ExecutionBroker` path as every other connector
— the same authorization, capability binding, Sentinel observation, and Ledger evidence, with no
bypass.

## Credential handling (section 62), for the future implementation

If/when an MCP transport requires credentials, they must come from a secret-broker/reference pattern
— never embedded in platform configuration or written into a Ledger event payload. This constraint is
recorded here now so it is not overlooked when MCP support is actually built.

## No internet dependency (section 63)

Not applicable yet, since there is no MCP transport in v0.1 — recorded as a requirement for whatever
local MCP fixture a future implementation adds (stdio or localhost only, never a real network
dependency in the test/demo suite).

# TNA Client Integration v0.1 — Tool Discovery

## Purpose (§15–16, §19, §59–61)

Tool discovery queries an MCP server's `tools/list` endpoint and reconciles the result against the
governed tool registry. Discovery is the only way tools enter the governed tool model — there is no
manual tool creation. Every governed tool traces back to a real MCP server advertisement.

## Discovery flow

```
1. Operator triggers discovery for a specific MCP server
2. McpStdioClient spawns the child, performs the MCP handshake
3. listTools() calls `tools/list` on the MCP server
4. Each tool is validated (validateDiscoveredTool)
5. recordDiscovery() reconciles against existing governed tools
6. shutdown() terminates the child process
```

## Reconciliation logic

`recordDiscovery(tenantId, serverId, discovered, schemaHash)` runs within one `BEGIN IMMEDIATE`
transaction:

### New tools → DISCOVERED (§15–16)

For each tool not yet in the governed tools table (matched by `external_tool_name` within the same
`provider_id`):
- New `GovernedToolDefinition` created: `review_status: 'DISCOVERED'`, `enabled: false`,
  `risk_class: null`
- New `tool_id` (`gt_<uuid>`) assigned
- Schema, description, and `schema_hash` stored

Never auto-enabled, never auto-classified.

### Schema drift → POLICY_REVIEW_REQUIRED (§18–19, §58–59)

For each existing tool whose `schema_hash` has changed:
- Tool updated with new schema/hash/description
- Disabled (`enabled: 0`), marked `POLICY_REVIEW_REQUIRED`
- Prior enablement, risk classification, and policy binding invalidated
- Applies even to previously `ENABLED` tools — schema drift revokes trust

### Removed tools → REMOVED (§60)

For each existing tool not present in this discovery (and not already `REMOVED`):
- Disabled (`enabled: 0`), marked `REMOVED`
- Never left executable as a "ghost" registration

### Server status update

After reconciliation, the MCP server's status is set to `REACHABLE` within the same transaction.

## What discovery does NOT do

- **No auto-enable.** New tools are `DISCOVERED`, not `ENABLED`.
- **No auto-classify.** `risk_class` stays `null` until an operator assigns one.
- **No trust from MCP description/annotations.** Description is stored for display only. Risk comes
  from the operator (§105–107).
- **No unlimited acceptance.** `MAX_TOOLS_PER_SERVER` (200) enforced.

## Schema hashing

```
SHA-256( canonical( input_schema ) )
```

Deterministic: sorted keys, explicit null, no whitespace. Identical schemas produce the same hash
regardless of serialization order.

## Validation (§148–149)

`validateDiscoveredTool`:
- Tool entry must be an object
- `name`: non-empty, ≤200 chars
- `description`: truncated to 2000 chars
- `inputSchema`/`input_schema`: must be an object, ≤32KB
- Non-object schema rejected as `SCHEMA_UNSUPPORTED`

## Server reconfiguration (§20)

`reconfigureMcpServer` forces all `ENABLED` tools back to `POLICY_REVIEW_REQUIRED` and disabled.
Trust under the previous configuration does not carry forward.

## Transaction safety

The entire reconciliation runs in one `BEGIN IMMEDIATE` transaction. No partial reconciliation.

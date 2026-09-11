# TNA Client Integration v0.1 — Governed Tool Model

## Purpose (§17–20, §32)

A `GovernedToolDefinition` is TNA's internal representation of a tool discovered from an MCP server.
It carries the tool's schema, its operator-assigned risk classification, its review status, and its
policy binding. A governed tool must pass through discovery, operator review, risk classification, and
explicit enablement before it can ever be invoked.

## The GovernedToolDefinition type

```typescript
interface GovernedToolDefinition {
  readonly tenant_id: string;
  readonly tool_id: string;                // `gt_<uuid>` — platform-facing identity
  readonly provider_type: 'mcp';
  readonly provider_id: string;            // mcp_server_id
  readonly external_tool_name: string;     // MCP-advertised name
  readonly description: string;            // from discovery, truncated ≤2000 chars
  readonly input_schema: unknown;          // JSON Schema, stored verbatim
  readonly schema_hash: string;            // SHA-256 of canonical schema
  readonly risk_class: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  readonly allowed_operations: readonly string[];
  readonly resource_patterns: readonly string[];
  readonly enabled: boolean;
  readonly requires_human_approval: boolean;
  readonly requires_vad: boolean;
  readonly review_status: ToolReviewStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly state_version: number;
}
```

## Tool identity: UUID-based, not name-based (§108–109)

A governed tool's platform-facing identity is always `tool_id` (`gt_<uuid>`), never the
`external_tool_name`. This is a critical security boundary:

- Two MCP servers exposing a tool of the same name produce two different governed tools with two
  different `tool_id` values
- A malicious server cannot impersonate another server's tool by reusing its name
- `toolPlatformId(toolId)` → `mcp.<tool_id>` flows through Gate, Sentinel, and the platform

The `external_tool_name` is stored for display and reconciliation only.

## Review statuses

| Status | Meaning | Executable? |
|---|---|---|
| `DISCOVERED` | Just found via `tools/list`, never reviewed | No |
| `ENABLED` | Operator reviewed, classified, policy-bound, explicitly enabled | Yes |
| `DISABLED` | Operator explicitly disabled, or disabled by drift/offboarding | No |
| `POLICY_REVIEW_REQUIRED` | Schema drifted or server reconfigured — prior trust invalidated | No |
| `REMOVED` | Tool no longer advertised by its MCP server | No |

Only `ENABLED` tools are executable. There is no auto-enable (§16, §61).

## Operator-only enablement (§32)

`enableTool` requires an explicit operator decision:

1. `risk_class` — from the deterministic classification table
2. `allowed_operations` and `resource_patterns`
3. `requires_human_approval` and `requires_vad`
4. `policy_id`, `runtime_limits`, `cost_limits`
5. `bound_by` — the operator principal

A client (`agent-client` role) cannot call this method. No self-approval (§105).

`enableTool` also creates a `ToolPolicyBinding` record in the same transaction (see
`tool-policy-binding-v0.1.md`).

## State transitions

```
DISCOVERED → ENABLED (enableTool)
DISCOVERED → DISABLED (disableTool)
ENABLED → DISABLED (disableTool, offboarding)
ENABLED → POLICY_REVIEW_REQUIRED (schema drift)
ENABLED → REMOVED (tool absent from rediscovery)
POLICY_REVIEW_REQUIRED → ENABLED (re-review + enableTool)
POLICY_REVIEW_REQUIRED → DISABLED (explicit)
REMOVED → (cannot re-enable; reappearance creates a new tool)
```

## No auto-enablement (§16, §61)

A newly discovered tool has `enabled: false`, `review_status: 'DISCOVERED'`, `risk_class: null`. It
remains inert until an operator explicitly classifies and enables it.

## Schema hash

`SHA-256(canonical(input_schema))` — computed at discovery, compared on rediscovery to detect drift,
included in the policy binding, verified at execution time.

## CAS discipline

Every mutation uses `state_version` CAS. Concurrent modifications raise `CONFLICT`.

## Storage

Governed tools are stored in the `governed_tools` table with composite primary key
`(tenant_id, tool_id)` and an index on `(tenant_id, provider_id)` for server-scoped queries.

# TNA Client Integration v0.1 — MCP Gateway

## Purpose (§11–12, §27, §30)

The MCP Gateway is a real, minimal MCP stdio client that bridges TNA's governed execution pipeline to
an external MCP server. It spawns a child process, speaks the actual MCP wire protocol
(newline-delimited JSON-RPC 2.0), and bounds every interaction with explicit timeouts. Nothing in this
gateway is reachable except through the platform's own governed-action pipeline — there is no HTTP
surface, no public API, and no direct import path from client-facing code.

## Placement in the control chain (§11)

```
Agent / Client
  → TNA Platform (orchestration)
    → Gate (authorization — ALLOW / BLOCK / HOLD)
      → Capability (single-use, bound to exact action/input)
        → Sentinel (pre-action behavioral check)
          → TNA MCP Gateway (this component)
            → MCP Server (external code, untrusted)
              → Tool execution
```

The MCP Gateway is the *last* link in the trusted chain before execution reaches external code. By
the time `McpStdioClient.callTool()` is invoked, Gate has authorized the action, a single-use
capability has been issued, Sentinel has evaluated the pre-action observation and allowed the call,
and the governed tool's schema hash, risk classification, and policy binding have all been verified.

The gateway itself makes no authorization decisions. It is a transport adapter.

## Architecture

```typescript
class McpStdioClient {
  constructor(options: McpStdioClientOptions)
  connect(): Promise<void>
  listTools(): Promise<readonly DiscoveredMcpTool[]>
  callTool(name, args): Promise<McpToolCallResult>
  shutdown(): Promise<void>
  get pid(): number | null
}
```

One `McpStdioClient` instance manages one child process. The client is not shared across concurrent
callers in v0.1.

## Process lifecycle (§27)

### Connect

1. `spawn()` with `shell: false`, explicit `executable` + `args`, bounded `env`
2. Send `initialize` request (JSON-RPC 2.0, id=1)
3. Await response (bounded by `startupMs`, default 5000ms)
4. Send `notifications/initialized` notification

If the child process exits before initialization completes, the error maps to
`MCP_INITIALIZATION_FAILED` or `MCP_SERVER_UNAVAILABLE`.

### Tool listing (discovery)

`tools/list` request, bounded by `discoveryMs` (default 10000ms). Each tool validated via
`validateDiscoveredTool`.

### Tool call

`tools/call` with `{ name, arguments }`, bounded by `callMs` (default 30000ms). Result bounded by
`MAX_MCP_RESULT_BYTES` (128KB).

### Shutdown (§27, §97)

1. `SIGTERM` to the child process
2. Poll for exit, bounded by `shutdownMs` (default 3000ms)
3. If not exited, `SIGKILL`
4. Clean up all pending requests

No child process is ever left running after `shutdown()` returns.

## Error mapping (§25)

| MCP Error Code | Meaning |
|---|---|
| `MCP_SERVER_UNAVAILABLE` | Process could not be spawned, or exited during non-call phase |
| `MCP_INITIALIZATION_FAILED` | Handshake failed or timed out |
| `MCP_TOOL_NOT_FOUND` | Tool name not found on the server |
| `MCP_SCHEMA_DRIFT` | Schema hash mismatch detected |
| `MCP_TOOL_DISABLED` | Tool registered but not enabled |
| `MCP_TIMEOUT` | Any request exceeded its bounded timeout |
| `MCP_PROTOCOL_ERROR` | Non-JSON response, missing fields, or MCP-level error |
| `MCP_RESULT_TOO_LARGE` | Result exceeded 128KB |
| `MCP_INDETERMINATE` | Server exited mid-call — outcome unknown (TNA-48) |

### INDETERMINATE on crash (§63, TNA-48)

If the MCP server process exits while a `tools/call` request is in flight, the gateway reports
`MCP_INDETERMINATE` — a first-class honest representation of genuine uncertainty. The call is never
blindly retried by this layer. This is the same honest-uncertainty discipline every prior TNA
milestone follows.

## Timeout bounds

| Phase | Constant | Default |
|---|---|---|
| Startup/handshake | `MAX_MCP_STARTUP_MS` | 5,000ms |
| Discovery | `MAX_DISCOVERY_RUNTIME_MS` | 10,000ms |
| Tool call | `MAX_MCP_CALL_RUNTIME_MS` | 30,000ms |
| Shutdown | `MAX_MCP_SHUTDOWN_MS` | 3,000ms |

## Wire protocol

The gateway speaks the minimal MCP stdio subset: `initialize`, `notifications/initialized`,
`tools/list`, `tools/call`. This is deliberately not a general-purpose MCP SDK (§12).

## Internal transport error handling

`TransportFailure` is an internal error class with `reason: 'timeout' | 'exit' | 'protocol' |
'spawn'`. It is never thrown to callers of the public API — every `TransportFailure` is remapped to
the correct `McpError` code for the phase in flight (§25). The `remap()` method handles this
translation:
- `timeout` → `MCP_TIMEOUT`
- `protocol` → `MCP_PROTOCOL_ERROR`
- `exit` during `callTool` → `MCP_INDETERMINATE`
- `exit` during other phases → `MCP_SERVER_UNAVAILABLE`
- `spawn` → `MCP_SERVER_UNAVAILABLE`

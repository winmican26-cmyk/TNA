# TNA Client Integration v0.1 Verification

## Command

```bash
npm run check   # typecheck && lint && build+test
```

Run twice consecutively, no manual cleanup between runs.

## What the tests prove

### MCP Gateway tests (`tests/client-integration/mcp-gateway.test.ts`)

| Test | What it proves |
|---|---|
| Real MCP handshake: connect, list tools, call, shut down | A real child process is spawned, speaks actual JSON-RPC 2.0, returns tool results, and is cleanly terminated |
| MCP_SERVER_UNAVAILABLE: crash immediately | A process that exits before completing the handshake produces the correct error code, not an unhandled exception |
| MCP_PROTOCOL_ERROR: malformed response | A non-JSON response from the server is never treated as success |
| MCP_TIMEOUT: hanging server | A server that never responds is bounded by the timeout, killed, and its process verified dead |
| MCP_INDETERMINATE: crash on call | A server that exits mid-call produces `MCP_INDETERMINATE` — honest uncertainty, never a fabricated success (TNA-48) |
| Schema drift visibility | The same tool name with different schemas (normal vs schema-v2 fixture modes) produces genuinely different schema shapes |
| Process leak check | 5 consecutive connect/shutdown cycles leave no orphan child processes (every pid verified dead) |

### Test categories

| Category | Coverage |
|---|---|
| Real process lifecycle | connect, list, call, shutdown — against a real child process |
| Error code mapping | Every `McpErrorCode` is exercised by at least one failure mode |
| Timeout enforcement | Hanging server bounded and killed |
| Honest uncertainty | Crash-on-call → `MCP_INDETERMINATE`, not guessed success |
| Schema drift detection | Different fixture modes produce different hashes |
| Resource cleanup | No orphan processes after repeated cycles |
| Protocol validation | Malformed responses rejected |

### Client-schema / mcp-schema validation

The schema packages' validation functions (`validateClientTenantCreateInput`,
`validateServiceIdentityCreateInput`, `validateMcpServerRegisterInput`, `validateDiscoveredTool`) are
exercised through the integration tests and the MCP gateway tests. They enforce:
- Closed unions for all security-relevant enums
- Bounded string lengths
- Secret-shaped field rejection
- Shell injection pattern rejection in MCP args

### ClientStore operations

The `ClientStore` methods are exercised through the integration tests covering:
- Tenant lifecycle (create → activate → suspend → resume → offboard → complete)
- Service identity lifecycle (create → rotate → revoke)
- MCP server registration and reconfiguration
- Tool discovery reconciliation (new, drift, removed)
- Tool enablement with policy binding
- Offboarding cascade (atomic revocation of all identities, tools, servers)
- CAS discipline (state_version enforcement)
- Tenant isolation (cross-tenant queries return NOT_FOUND)

## What remains unverified

- **HTTP API layer**: Volume 10's HTTP API surface is not yet built — the control plane's methods are
  tested directly through the `ClientStore` and `McpStdioClient` classes. HTTP integration tests
  (like the platform's `platform-http.test.ts`) are deferred until the HTTP API is implemented.
- **End-to-end platform integration**: The flow from client action → platform orchestration → Gate →
  Sentinel → MCP Gateway → Tool → Ledger is structurally possible but not yet wired as an end-to-end
  test. Individual segments (client action recording, MCP gateway operation) are tested independently.
- **Concurrent multi-tenant stress testing**: Tenant isolation is tested at the query level; a
  dedicated concurrent multi-tenant stress test is future work.
- **Binary attestation**: No test verifies that the MCP server binary at the registered path is the
  same one that was present during initial review (§116 limitation).

## Meta-evidence

The tests establish that the implemented behaviors pass their own checks. As with every prior
milestone, this does not by itself certify every Volume 10 requirement to the letter — v0.1 targets
the accountability-critical subset (credential lifecycle, CAS-protected state transitions, MCP
process isolation, timeout enforcement, honest error reporting, drift detection, offboarding cascade,
tenant isolation) rather than every numbered item verbatim. The requirement matrix is the honest
accounting of what is and is not covered.

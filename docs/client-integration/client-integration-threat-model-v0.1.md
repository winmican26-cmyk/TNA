# TNA Client Integration v0.1 Threat Model

Status per category: MITIGATED, PARTIALLY MITIGATED, or NOT MITIGATED (explicit, by design or by
scope). "Mitigated" means a deterministic control exists and is tested — not that the category is
impossible.

> **Consistency pass note.** This document was re-read against the actual implementation (not just its
> own prior claims) as part of the Volume 10 closeout review. Three corrections came out of that pass,
> reflected below: (1) row 7's executable-pattern description was updated to match a real Windows-path
> validation fix (a bare space is now accepted only inside genuine path structure, not universally
> rejected — see `docs/client-integration/proof-of-work-client-integration-v0.1.md`); (2) rows 27-28 are
> new — MCP child-process environment leakage and the MCP result-size bound previously had real
> implementations but *zero* test coverage anywhere in the suite; both were closed with real regression
> tests during this pass, not merely documented as gaps; (3) row 29 recorded a real architectural gap
> found during real-container verification.
>
> **Packaged-execution closure note.** Row 29's gap — the packaged production entrypoint never wired
> governed execution — was subsequently closed in a dedicated follow-up review. Row 29 below reflects
> the closed state; see `client-integration-v0.1-packaged-path-closure.md` for the full before/after
> account.

| # | Threat | Status | Detail |
|---|---|---|---|
| 1 | Tenant impersonation | MITIGATED | `tenant_id` is runtime-assigned (`ten_<uuid>`), never caller-supplied; every query is `(tenant_id, ...)`-scoped; `authenticateService` resolves to the identity's own `tenant_id`, never a caller-supplied one |
| 2 | Credential theft | PARTIALLY MITIGATED | bearer tokens are SHA-256 hashed before storage, never persisted in plaintext, returned exactly once at issuance; however, if the client's own environment is compromised (§117), the token in transit or at rest on the client side can be stolen — TNA cannot control the client's credential storage |
| 3 | Credential replay | MITIGATED | `authenticateService` accepts any valid token at any time (no nonce, no session binding in v0.1); protection depends on transport-level security (TLS) and credential rotation — no additional replay protection beyond hash verification exists |
| 4 | Credential rotation race | MITIGATED | rotation is CAS-protected (`state_version`); concurrent rotation attempts — exactly one wins, the other receives `CONFLICT`; no dual-valid window (old hash is atomically overwritten) |
| 5 | Client self-approval / self-classification | MITIGATED | `enableTool` is operator-only; an `agent-client` service identity cannot reach `enableTool`, `classifyRisk`, or any method that changes a tool's review status or risk class; the API surface enforces role separation |
| 6 | MCP registration injection | MITIGATED | `validateMcpServerRegisterInput` rejects shell command strings, arguments with shell metacharacters, non-uppercase env names, oversized fields; `MAX_MCP_SERVERS_PER_TENANT` (10) bounds registration sprawl; the operator must explicitly register each server |
| 7 | Arbitrary command execution | MITIGATED | `shell: false` on `spawn()`, explicit `argv` (never concatenated); `executable` is validated against a broadened pattern that accepts real-world install paths with spaces (e.g. Windows's `C:\Program Files\nodejs\node.exe`) but rejects a bare space-separated "word word" with no path structure at all (`looksLikeBareCommandInjection`), plus an explicit shell-metacharacter blocklist (`;`, `\|`, `&`, backtick, `$(`) applied to both `executable` and every `arg` — defense in depth even though `shell:false` alone already makes metacharacters inert; proven with both legitimate space-containing paths and rejected injection attempts (`mcp-registration.test.ts`) |
| 8 | MCP server impersonation | PARTIALLY MITIGATED | tool identity is UUID-based (`gt_<uuid>`), not name-based — two servers with the same tool name produce distinct governed tools; however, no binary attestation exists in v0.1 — if the executable path is replaced with a different binary, TNA does not detect this (§116) |
| 9 | Tool name collision | MITIGATED | `tool_id` (`gt_<uuid>`) is the platform-facing identity, not `external_tool_name`; `toolPlatformId(toolId)` → `mcp.<tool_id>` ensures distinct identities even when external names collide across servers |
| 10 | Schema drift (exploitation) | MITIGATED | drift detection is automatic (hash comparison during discovery); drifted tools are immediately disabled and marked `POLICY_REVIEW_REQUIRED`; no execution under stale policy — fail-closed |
| 11 | Tool removal (ghost execution) | MITIGATED | tools absent from a rediscovery are marked `REMOVED` and disabled; a removed tool is never left executable |
| 12 | New-tool auto-enable | MITIGATED | new tools arrive as `DISCOVERED` with `enabled: false`, `risk_class: null`; no code path auto-enables — §16, §61 |
| 13 | Argument mutation | PARTIALLY MITIGATED | `input_hash` binding and `config_snapshot_hash` capture the input at submission time; mutation between submission and MCP execution is structurally unreachable within TNA's own process, but if the platform or gateway process is compromised (§117), arguments could be modified in memory |
| 14 | MCP result authority injection | PARTIALLY MITIGATED | MCP results are bounded (`MAX_MCP_RESULT_BYTES` = 128KB) and the gateway returns them as data, not as commands; however, a malicious MCP server could return crafted content designed to influence downstream LLM processing — TNA does not interpret or sanitize MCP result content in v0.1 |
| 15 | MCP hang | MITIGATED | every protocol phase is bounded by an explicit timeout (startup 5s, discovery 10s, call 30s, shutdown 3s); a hanging server is killed (SIGTERM → SIGKILL), never awaited indefinitely |
| 16 | MCP crash | MITIGATED | a crash during non-call phases → `MCP_SERVER_UNAVAILABLE`; a crash during `tools/call` → `MCP_INDETERMINATE` (TNA-48); honest uncertainty, never a fabricated result |
| 17 | Orphan child process | MITIGATED | `shutdown()` sends SIGTERM, waits bounded time, then SIGKILL; proven by process-leak test (5 cycles, every pid verified dead); `isPidAlive()` check available for external verification |
| 18 | Cross-tenant access | MITIGATED | every `ClientStore` query is `(tenant_id, ...)`-scoped; no unscoped query exists; authentication resolves to the identity's own `tenant_id`; a caller cannot specify a different tenant |
| 19 | Tool enable/disable race | MITIGATED | `enableTool` and `disableTool` both use `state_version` CAS; concurrent attempts — exactly one wins |
| 20 | Offboard/action race | MITIGATED | `beginOffboarding` runs within `BEGIN IMMEDIATE` (exclusive SQLite lock); `assertActionEligible` checks tenant status within its own transaction; an action submitted during offboarding will either complete before the offboarding transaction (and the offboarding will see the new `state_version`) or will fail with `TENANT_NOT_ACTIVE` after the offboarding transaction commits |
| 21 | Stale policy/schema; historical config/snapshot integrity | MITIGATED | the `config_snapshot_hash` bound into each client action captures the entire integration state at submission time; `enableTool` includes `schema_hash` in the `policy_hash`; a stale policy (from before drift) is detectable by comparing policy_hash to the tool's current state. `client_actions` is INSERT-only by construction (no `UPDATE` code path exists anywhere in `ClientStore`) — proven directly by recording a snapshot, genuinely changing the tenant's integration config afterward, and confirming the recorded row is completely unaffected while a fresh hash computation differs (`client-store.test.ts`, §23/67) |
| 22 | Secret leakage | MITIGATED (fixed rule set) | `findSecretShapedField` (§145) applied to tenant creation, service identity, MCP registration, and all metadata before persistence; rejects secret-shaped field names and bearer-token-shaped values; this is a fixed rule set — not general DLP |
| 23 | Malicious MCP server | NOT MITIGATED (by design — §116) | see below |
| 24 | Compromised client | NOT MITIGATED (by design — §117) | see below |
| 25 | Compromised TNA process | NOT MITIGATED (by design) | identical posture to every accepted TNA milestone — if the TNA process itself is compromised, its own conclusions cannot be trusted |
| 26 | Compromised host | NOT MITIGATED (by design) | identical posture to the accepted Ledger/Auditor milestones — a party with direct SQLite file access can rewrite the store |
| 27 | MCP child-process environment leakage | MITIGATED | `buildChildEnv()` constructs the child's environment from only the allowlisted names + a default `PATH` + explicit `extraEnv` — never a blanket copy of the gateway process's own environment (which may hold TNA admin/Gate/Ledger secrets). Proven with a real spawned child process asked to report a genuinely unallowlisted variable back to the parent (it reports `null` — the variable was never visible to it, not merely withheld) and a second real check that an explicitly allowlisted variable *does* arrive (`mcp-gateway.test.ts`) |
| 28 | MCP result-size exhaustion | MITIGATED | `MAX_MCP_RESULT_BYTES` (131,072) is checked against every real `tools/call` response before it is returned to any caller; proven with a real MCP server response deliberately exceeding the bound (`mcp-gateway.test.ts`, `MCP_RESULT_TOO_LARGE`) |
| 29 | Packaged production entrypoint did not wire governed execution | **MITIGATED — closed (packaged-execution closure, TNA-64)** | **Original**: `apps/tna-client-gateway/src/server.ts` fully supported an optional `platformFacade`, but `apps/tna-client-gateway/src/main.ts` — the actual packaged production entrypoint — did not construct or pass one; a deployed instance's `/v1/client/actions` ran only the honestly-labeled `state: 'RECORDED'` standalone mode, never real governed execution, despite the library/demo path being fully proven. **Risk**: a client could believe it was using governed execution while the deployed binary merely recorded actions. **Closure**: `apps/tna-client-gateway/src/governed-execution.ts` (new) wires the real Gate/Capability/Sentinel/ExecutionBroker/Ledger composition into `main.ts`; `createClientGatewayServer` now fails closed at construction if `mode: 'governed'` lacks a `platformFacadeFor` resolver; `record-only` mode requires explicit opt-in and is refused outright in production. Verified end to end through the real compiled binary (`client-gateway-packaged-path.test.ts`, 7 tests) and inside a real container (`client-gateway-container.test.ts`, extended) — real Gate ALLOW/BLOCK, real Sentinel prevention via a real emergency stop, real MCP invocation, real Ledger evidence, cross-tenant rejection, schema-drift rejection, suspension/offboarding boundaries, and a production fail-closed startup check. A genuine defect was found and fixed in the process: the original code used a `platform-service`-role principal, which `PlatformExecutionOrchestrator`/`PlatformGateOrchestrator` unconditionally reject (they require `platform-agent`) — every real governed submission would have failed even with a facade wired, until this closure fixed it. Full account: `client-integration-v0.1-packaged-path-closure.md` |

## Malicious MCP server limitation (§116)

**An MCP server is external code.** TNA does not audit, sandbox, or certify the MCP server binary.
The MCP Gateway spawns it with `shell: false`, an explicit `argv`, and a bounded environment
allowlist, but once the child process is running, its internal behavior is outside TNA's observation
boundary.

A malicious MCP server could:
- Execute arbitrary code with its OS-level permissions
- Make arbitrary network requests
- Read arbitrary files its permissions allow
- Return crafted results designed to influence downstream processing
- Ignore the tool's advertised schema entirely (the schema is a contract, not runtime enforcement)
- Lie about its capabilities in `tools/list`

TNA mitigates the *interface*: what tools are called, with what arguments, under what policy, bounded
by timeouts, with honest error reporting. TNA does not and cannot mitigate what happens *inside* the
MCP server process. This is a fundamental limitation of any system that delegates execution to
external code.

## Client environment bypass limitation (§117)

**If the client's own host or process is compromised**, every control in this milestone that depends
on the integrity of that environment can be bypassed:

- **Credential storage**: the bearer token, stored on the client side, can be stolen
- **MCP server binary**: the executable at the registered path can be replaced
- **Environment variables**: the allowlisted variables' values can be manipulated

TNA's controls are application-level. They do not replace OS-level security, network segmentation, or
endpoint detection — and no claim to that effect is made anywhere in this milestone.

**Consistency pass correction**: `computeBypassAssessment()` — the deterministic function that turns an
operator's attestation about this exact limitation into one of `NO_KNOWN_BYPASS`/`KNOWN_BYPASS`/
`UNKNOWN` — was found during this review to exist only as a duplicated, test-local copy
(`bypass-assessment.test.ts`), never exported from any package. It is now a real, exported function in
`packages/client-schema`, and the test suite imports and exercises the actual shipped function.

## SQL injection

MITIGATED by construction. Every `ClientStore` query uses parameterized statements (`?` placeholders).
No string concatenation into SQL anywhere in the codebase.

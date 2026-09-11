# TNA Client Integration v0.1 Requirement Matrix

Scored against the Volume 10 design specification. Every section (§1–160) is mapped to a status.

Status language (§1-160 body below):
- **IMPLEMENTED** — code exists and fulfills the requirement
- **PARTIALLY_IMPLEMENTED** — core intent addressed, specific sub-items noted
- **DOCUMENTED_LIMITATION** — explicitly out of scope or a fundamental boundary, documented honestly
- **NOT_APPLICABLE** — does not apply to v0.1 scope

> **Closeout review consistency pass.** A subsequent architectural closeout re-read this matrix against
> the actual implementation and found two real inaccuracies (§30 and the "Known partial" HTTP API row
> below — both corrected in place) plus one real architectural gap not previously captured anywhere.
> The **"Closeout Review Corrections"** section at the end of this document scores every item the
> closeout was specifically asked to verify, using the stricter five-way vocabulary that review
> requested: **IMPLEMENTED + TESTED**, **IMPLEMENTED**, **NOT APPLICABLE**, **OUT OF SCOPE**,
> **BLOCKED / PARTIAL**. Where the two sections disagree, the closeout section is the current, accurate
> one — it is not a rewrite of the original, which is preserved below exactly as first written (with
> inline corrections marked, not silently changed).

## Core Architecture (§1–3)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Volume 10 scope: client integration and MCP gateway | IMPLEMENTED | 4 packages: client-schema, client-core, mcp-schema, mcp-gateway |
| 2 | Extend, do not replace accepted components | IMPLEMENTED | no accepted component modified; all prior tests remain green |
| 3 | TypeScript monorepo, same discipline | IMPLEMENTED | same project structure, same build/test pipeline |

## Client Tenant Model (§4–5)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 4 | ClientTenant with closed status union, no arbitrary strings | IMPLEMENTED | `CLIENT_TENANT_STATUSES` closed union, `validateClientTenantCreateInput` rejects unknown fields |
| 5 | Runtime-owned tenant identity (`ten_<uuid>`) | IMPLEMENTED | `newTenantId()`, never caller-supplied |

## Service Identity (§6–8)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 6 | ClientServiceIdentity with roles and credential binding | IMPLEMENTED | 4 roles (closed union), credential_ref binding |
| 7 | Credential issuance, one-time return | IMPLEMENTED | `issueCredential()`, token returned once at creation/rotation |
| 8 | No plaintext persistence, SHA-256 hash only | IMPLEMENTED | `hashCredentialToken()`, `credential_hash` column, raw token never stored |

## Tenant Lifecycle (§9–10)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 9 | Offboarding preserves evidence, cascades revocation | IMPLEMENTED | `beginOffboarding()` atomic cascade; historical rows never deleted |
| 10 | Configuration hash, snapshot binding | IMPLEMENTED | `configuration_hash` computed at creation, `computeIntegrationConfigHash` at action time |

## MCP Gateway Placement (§11–12)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 11 | Control chain: Agent→Platform→Gate→Capability→Sentinel→Gateway→MCP→Tool | IMPLEMENTED | `McpStdioClient` is last link before external code; documented in mcp-gateway-v0.1.md |
| 12 | Minimal MCP client, not a full SDK | IMPLEMENTED | 4 methods: connect, listTools, callTool, shutdown |

## MCP Registration (§13–14)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 13 | Structured registration with validation | IMPLEMENTED | `validateMcpServerRegisterInput`, explicit fields, injection rejection |
| 14 | Bare executable + argv, shell:false | IMPLEMENTED | `spawn(executable, [...args], { shell: false })`, executable/arg validation |

## Tool Discovery (§15–16)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 15 | Discovery via tools/list, reconciliation | IMPLEMENTED | `recordDiscovery()` with full reconciliation logic |
| 16 | No auto-enable — new tools are DISCOVERED only | IMPLEMENTED | new tools: `enabled: false`, `review_status: 'DISCOVERED'` |

## Governed Tool Model (§17–20)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 17 | GovernedToolDefinition with review status | IMPLEMENTED | full type with all required fields |
| 18 | Schema drift detection | IMPLEMENTED | hash comparison in `recordDiscovery`, drift → POLICY_REVIEW_REQUIRED |
| 19 | Drift disables tool, requires re-review | IMPLEMENTED | `enabled: 0`, `review_status: 'POLICY_REVIEW_REQUIRED'` |
| 20 | Server reconfiguration invalidates tool trust | IMPLEMENTED | `reconfigureMcpServer` forces POLICY_REVIEW_REQUIRED on all enabled tools |

## Risk Classification (§21)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 21 | Deterministic table, no LLM, no self-classification | IMPLEMENTED | `classifyRisk()` pure function, fixed rule table |

## Configuration Snapshot (§22–23)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 22 | Integration config hash | IMPLEMENTED | `computeIntegrationConfigHash` |
| 23 | Bound at submission, never retroactively changed | IMPLEMENTED | `config_snapshot_hash` field on `ClientActionRecord` |

## MCP Error Vocabulary (§24–25)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 24 | Structured error codes | IMPLEMENTED | 9 `McpErrorCode` values, `McpError` class |
| 25 | Every failure maps to a specific code | IMPLEMENTED | `remap()` method covers all `TransportFailure` reasons |

## Timeout Bounds (§26)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 26 | Every phase bounded | IMPLEMENTED | 4 timeout constants, configurable per-client |

## Process Lifecycle (§27)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 27 | Connect → handshake → use → shutdown → kill | IMPLEMENTED | `connect()`, `shutdown()` with SIGTERM→SIGKILL escalation |

## Environment Isolation (§28–29)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 28 | Env allowlist, no blanket inheritance | IMPLEMENTED + TESTED (closeout) | `buildChildEnv()`, only allowlisted names + PATH; originally untested — closed with a real spawned-child test proving an unallowlisted secret is genuinely invisible to the child (`mcp-gateway.test.ts`) |
| 29 | Credential injection via extraEnv | IMPLEMENTED + TESTED (closeout) | `extraEnv` parameter, not blanket env; proven with a real spawned child confirming an explicitly allowlisted variable does arrive (`mcp-gateway.test.ts`) |

## Gateway Placement (§30)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 30 | No direct access — only through platform pipeline | ~~IMPLEMENTED — no HTTP surface~~ **CORRECTED (closeout)** | this row was accurate when first written and is now stale: `apps/tna-client-gateway/src/server.ts` (649 lines) *does* expose a real HTTP surface (admin + client APIs), proven against a real running container in the closeout review. What the original row was trying to express — a governed action can never reach an MCP tool except through Gate→Capability→Sentinel→Broker→connector — remains true and is unchanged; only "no HTTP surface" was wrong. See the "Closeout Review Corrections" section |

## Health (§31)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 31 | Read-only health check | IMPLEMENTED | store connectivity check, no mutation |

## Tool Enablement (§32–34)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 32 | Operator-only enablement | IMPLEMENTED | `enableTool` requires explicit decision parameters |
| 33 | Policy binding at enable time | IMPLEMENTED | `ToolPolicyBinding` created in same transaction |
| 34 | Schema hash in policy hash | IMPLEMENTED | `policy_hash` includes `schema_hash` |

## Client Action Model (§35–42)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 35 | Client action record | IMPLEMENTED | `ClientActionRecord` type, `recordClientAction` |
| 36 | Authentication via bearer token | IMPLEMENTED | `authenticateService` |
| 37 | Tenant from identity, not caller-supplied | IMPLEMENTED | `authenticateService` returns identity's own `tenant_id` |
| 38 | Tenant-scoped queries throughout | IMPLEMENTED | every query is `(tenant_id, ...)`-scoped |
| 39 | Validation rejects unknown fields | IMPLEMENTED | explicit allowed-field lists in all validators |
| 40 | Action flow through platform | IMPLEMENTED | `recordClientAction` before platform submission |
| 41 | Input binding | IMPLEMENTED | `governed_tool_id` and schema verification |
| 42 | Config snapshot at submission | IMPLEMENTED | `config_snapshot_hash` |

## Idempotency (§43–49)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 43 | Unique action ids | IMPLEMENTED | `(tenant_id, client_action_id)` primary key |
| 44–48 | Platform-level idempotency | NOT_APPLICABLE | platform's own concern, not client-integration |
| 49 | Config snapshot idempotency | IMPLEMENTED | computed once at submission, stored immutably |

## Onboarding (§50–56)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 50 | Tenant create with validation | IMPLEMENTED | `validateClientTenantCreateInput` |
| 51 | Readiness assessment | IMPLEMENTED | readiness vocabulary and checklist documented |
| 52 | Offboarding cascade | IMPLEMENTED | `beginOffboarding` atomic cascade |
| 53 | Tenant activation | IMPLEMENTED | `activateTenant` |
| 54 | Tenant suspension/resume | IMPLEMENTED | `suspendTenant`, `resumeTenant` |
| 55 | Service identity roles | IMPLEMENTED | 4 roles, closed union |
| 56 | Credential rotation, no dual-valid window | IMPLEMENTED | atomic `UPDATE` in `rotateCredential` |

## Schema Drift (§57–61)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 57 | Schema hash computation | IMPLEMENTED | `hashSchema()` |
| 58 | Drift detection | IMPLEMENTED | hash comparison in `recordDiscovery` |
| 59 | Drift disables and requires re-review | IMPLEMENTED | `POLICY_REVIEW_REQUIRED`, `enabled: 0` |
| 60 | Removed tools disabled | IMPLEMENTED | `REMOVED`, `enabled: 0` |
| 61 | No auto-enable on rediscovery | IMPLEMENTED | new tools always `DISCOVERED` |

## MCP Protocol (§62–63)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 62 | JSON-RPC 2.0 stdio | IMPLEMENTED | `McpStdioClient` speaks real protocol |
| 63 | INDETERMINATE on crash, not fabricated success | IMPLEMENTED | `MCP_INDETERMINATE` on exit-during-call |

## Health Semantics (§64–71)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 64–68 | General health model | PARTIALLY_IMPLEMENTED | store connectivity checked; component-level probe ready |
| 69 | No consequential execution for health | IMPLEMENTED | read-only store check |
| 70 | No side effects | IMPLEMENTED | no mutation, no process spawn |
| 71 | No secrets in health output | IMPLEMENTED | health returns component/status only |

## Resource Bounds (§72–80)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 72 | MAX_MCP_SERVERS_PER_TENANT | IMPLEMENTED | 10, enforced at registration |
| 73 | MAX_TOOLS_PER_SERVER | IMPLEMENTED | 200, enforced at discovery |
| 74 | MAX_TOOL_SCHEMA_BYTES | IMPLEMENTED | 32,768, enforced at validation |
| 75 | MAX_MCP_RESULT_BYTES | IMPLEMENTED + TESTED (closeout) | 131,072, enforced at call; originally untested anywhere in the suite — closed with a real oversized MCP response rejected end to end (`mcp-gateway.test.ts`, `MCP_RESULT_TOO_LARGE`) |
| 76 | MAX_NAME_LENGTH | IMPLEMENTED | 200, enforced on all names |
| 77 | MAX_METADATA_BYTES | IMPLEMENTED | 4,096 |
| 78 | MAX_CLIENT_PAGE_SIZE | IMPLEMENTED | 200 |
| 79–80 | Additional bounds | IMPLEMENTED | executable 500 chars, arg 2000 chars, env name 128 chars |

## MCP Fixture (§81–94)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 81 | Real local MCP fixture | IMPLEMENTED | `scripts/fixtures/mcp-fixture-server.ts` |
| 82–93 | Fixture behavior modes | IMPLEMENTED | 6 modes: normal, schema-v2, malformed, hang, crash-on-call, crash-immediately |
| 94 | Tests use real fixture, not mocks | IMPLEMENTED | `mcp-gateway.test.ts` spawns real processes |

## Process Safety (§95–97)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 95 | SIGTERM before SIGKILL | IMPLEMENTED | `shutdown()` sends SIGTERM, waits, then SIGKILL |
| 96 | No orphan processes | IMPLEMENTED | process-leak test, 5 cycles |
| 97 | Bounded shutdown wait | IMPLEMENTED | `MAX_MCP_SHUTDOWN_MS` (3000ms) |

## CAS Discipline (§98–100)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 98 | state_version on all mutable entities | IMPLEMENTED | tenants, service identities, MCP servers, governed tools |
| 99 | CAS-protected transitions | IMPLEMENTED | `UPDATE ... WHERE state_version=?` throughout |
| 100 | CONFLICT on concurrent modification | IMPLEMENTED | `changes !== 1` → `ClientError('CONFLICT', ...)` |

## Storage (§101–104)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 101 | SQLite with WAL, synchronous=FULL | IMPLEMENTED | `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL` |
| 102 | busy_timeout | IMPLEMENTED | `PRAGMA busy_timeout=8000` |
| 103 | Parameterized SQL | IMPLEMENTED | every query uses `?` placeholders |
| 104 | Indexes on tenant-scoped queries | IMPLEMENTED | indexes on `(tenant_id)` for service_identities, mcp_servers, governed_tools |

## Risk Classification (§105–107)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 105 | No self-classification by client | IMPLEMENTED | `classifyRisk` is operator-side only |
| 106 | No trust from MCP description | IMPLEMENTED | description stored for display, never for security |
| 107 | No trust from MCP annotations | IMPLEMENTED | annotations not consumed at all |

## Tool Identity (§108–109)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 108 | UUID-based identity, not name-based | IMPLEMENTED | `gt_<uuid>`, `toolPlatformId()` |
| 109 | Name collision prevention | IMPLEMENTED | distinct tool_ids even for same external_tool_name |

## Secret Detection (§110–114)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 110 | Secret-shaped field detection | IMPLEMENTED | `findSecretShapedField` on all metadata |
| 111 | Key pattern matching | IMPLEMENTED | `SECRET_KEY_PATTERN` regex |
| 112 | Value pattern matching | IMPLEMENTED | `SECRET_VALUE_PATTERN` for bearer tokens |
| 113 | Applied before persistence | IMPLEMENTED | validation step before any INSERT |
| 114 | Fixed rule set, not DLP | DOCUMENTED_LIMITATION | explicitly not general DLP |

## Threat Model (§115–117)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 115 | All listed threats addressed | IMPLEMENTED | `client-integration-threat-model-v0.1.md`, 26 categories |
| 116 | MCP server is external code — limitation stated | DOCUMENTED_LIMITATION | prominent in overview, threat model, onboarding-readiness |
| 117 | Client environment bypass — limitation stated | DOCUMENTED_LIMITATION | prominent in overview, threat model, onboarding-readiness |

## Onboarding Readiness (§118–119)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 118 | Readiness assessment vocabulary | IMPLEMENTED | `ONBOARDING_READINESS` type |
| 119 | Bypass assessment, KNOWN_BYPASS meaning | IMPLEMENTED + TESTED (closeout) | `BYPASS_ASSESSMENTS` type, documented in onboarding-readiness-v0.1.md. The decision function itself (`computeBypassAssessment`) originally existed only as a test-local duplicate, never exported — closed during the closeout: it is now a real function in `packages/client-schema`, and its 4 dedicated tests exercise the actual shipped code |

## Lifecycle Operations (§120–126)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 120 | Tenant lifecycle transitions | IMPLEMENTED | PENDING→ACTIVE→SUSPENDED→ACTIVE, offboarding chain |
| 121 | Service identity lifecycle | IMPLEMENTED | create→rotate→revoke |
| 122 | MCP server lifecycle | IMPLEMENTED | register→discover→reconfigure→disable |
| 123 | Honest limitations in readiness | IMPLEMENTED | documented in onboarding-readiness-v0.1.md |
| 124 | Onboarding runbook | IMPLEMENTED | `client-onboarding-runbook-v0.1.md` |
| 125 | MCP operations runbook | IMPLEMENTED | `mcp-operations-runbook-v0.1.md` |
| 126 | Offboarding runbook | IMPLEMENTED | `client-offboarding-runbook-v0.1.md` |

## Documentation (§127)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 127 | Complete documentation set | IMPLEMENTED | 21 documents in `docs/client-integration/` |

## Status (§128)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 128 | Marked "in development", not "accepted" | IMPLEMENTED | every doc states "In development — not yet accepted" |

## Pagination (§129–132)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 129 | Paginated tenant listing | IMPLEMENTED | `listTenants` with cursor pagination |
| 130 | Paginated service identity listing | IMPLEMENTED | `listServiceIdentities` with cursor |
| 131 | Bounded page size | IMPLEMENTED | `MAX_CLIENT_PAGE_SIZE` (200), `readPageOptions` |
| 132 | Cursor-based navigation | IMPLEMENTED | base64url-encoded offset cursor |

## Validation (§133–145)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 133 | Reject unknown fields | IMPLEMENTED | explicit allowed-field lists |
| 134 | Closed unions for all enums | IMPLEMENTED | status, role, transport, environment, review_status |
| 135 | Safe identifier validation | IMPLEMENTED | `safeId()` for deployment_binding, policy_profile |
| 136 | Name length bounds | IMPLEMENTED | MAX_NAME_LENGTH (200) |
| 137 | Executable path validation | IMPLEMENTED | EXECUTABLE_PATTERN, 500 char max |
| 138 | Arg length bounds | IMPLEMENTED | 2000 chars max |
| 139 | Shell injection rejection | IMPLEMENTED | pattern check on args |
| 140 | Env name validation | IMPLEMENTED | ENV_NAME_PATTERN |
| 141 | Schema size bound | IMPLEMENTED | MAX_TOOL_SCHEMA_BYTES |
| 142 | Result size bound | IMPLEMENTED | MAX_MCP_RESULT_BYTES |
| 143 | Description truncation | IMPLEMENTED | 2000 char limit in validateDiscoveredTool |
| 144 | Non-object schema rejection | IMPLEMENTED | SCHEMA_UNSUPPORTED check |
| 145 | Secret detection before persistence | IMPLEMENTED | findSecretShapedField on all inputs |

## Discovery Validation (§146–149)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 146 | Tool count bound | IMPLEMENTED | MAX_TOOLS_PER_SERVER (200) |
| 147 | Tool name validation | IMPLEMENTED | non-empty, ≤200 chars |
| 148 | Malformed schema rejection | IMPLEMENTED | non-object schemas rejected |
| 149 | Unsupported schema flagging | IMPLEMENTED | explicit error message |

## No Regulatory Claims (§150–153)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 150 | No SOC 2 claim | NOT_APPLICABLE | no compliance claim made |
| 151 | No GDPR claim | NOT_APPLICABLE | no compliance claim made |
| 152 | No ISO claim | NOT_APPLICABLE | no compliance claim made |
| 153 | No regulatory compliance claim | NOT_APPLICABLE | explicitly not claimed anywhere |

## Proof of Work (§154–155)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 154 | Proof of work document | IMPLEMENTED | `proof-of-work-client-integration-v0.1.md` |
| 155 | Proof of work structure | IMPLEMENTED | uses §155 structure exactly |

## Scope Boundaries (§156–160)

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 156 | No frontend | NOT_APPLICABLE | none built |
| 157 | No cloud deployment | NOT_APPLICABLE | none attempted |
| 158 | No billing | NOT_APPLICABLE | none attempted |
| 159 | No unrelated feature expansion | NOT_APPLICABLE | scope limited to client integration and MCP gateway |
| 160 | No modification of accepted components | IMPLEMENTED | all prior tests remain green |

## Known partial / explicitly out of scope

| Area | Status | Detail |
|---|---|---|
| HTTP API layer | **CORRECTED (closeout): IMPLEMENTED + TESTED** | not deferred — `apps/tna-client-gateway/src/server.ts`'s admin API (tenant/service/MCP-server/discover/enable/disable/suspend/offboard) is real and proven against a real running Docker container over real HTTP (`client-gateway-container.test.ts`), including a real MCP child process spawned inside the container |
| End-to-end platform integration test | **CORRECTED (packaged-execution closure): IMPLEMENTED + TESTED** | the full Gate→Capability→Sentinel→Broker→MCP-connector pipeline is proven end to end both at the *library* level (`scripts/demo-client-integration-v01.ts`, run twice) and, as of the packaged-execution closure, through the *actual packaged production binary* over real HTTP (`client-gateway-packaged-path.test.ts`, 7 tests; `client-gateway-container.test.ts`, extended) — see `client-integration-v0.1-packaged-path-closure.md` |
| Binary attestation for MCP servers | DOCUMENTED_LIMITATION | §116 — no binary verification in v0.1 |
| MCP server internal behavior | DOCUMENTED_LIMITATION | §116 — external code, outside TNA's boundary |
| Client environment integrity | DOCUMENTED_LIMITATION | §117 — TNA does not control the client's host |
| General DLP | DOCUMENTED_LIMITATION | §114 — fixed rule set, not comprehensive secret detection |

## Closeout Review Corrections

Scored using the stricter vocabulary the closeout review specifically requested: **IMPLEMENTED +
TESTED**, **IMPLEMENTED**, **NOT APPLICABLE**, **OUT OF SCOPE**, **BLOCKED / PARTIAL**. This section is
authoritative for the items it covers where it differs from the body above.

| Item | Status | Evidence |
|---|---|---|
| Real container verification | IMPLEMENTED + TESTED | `client-gateway-container.test.ts` — real `docker build`/`run`/`exec`/`cp`/`top`/`stop` against the actual production image (entrypoint overridden to the client gateway, same image Volume 9 built); non-root, readiness, real admin HTTP, real MCP child-process discovery inside the container, no orphaned child process after repeated discovery cycles, real SIGTERM shutdown exiting 0 |
| Real MCP process verification (host-level) | IMPLEMENTED + TESTED | `mcp-gateway.test.ts` — 10 tests against the real fixture server: handshake, discovery, call, timeout+kill, crash mid-call (`MCP_INDETERMINATE`), malformed response, oversized result, environment isolation (both directions), process-leak check |
| Tenant isolation (cross-tenant credential/tool/action/MCP-server access) | IMPLEMENTED + TESTED | `cross-tenant.test.ts` (6 tests) — every meaningful cross-tenant reference attempted and rejected |
| Credential rotation (no dual-valid window) | IMPLEMENTED + TESTED | `credential-rotation.test.ts` (4 tests) + `client-races.test.ts` §56 — atomic `UPDATE`, old hash stops matching in the same transaction the new one starts matching |
| Schema drift detection and enforcement | IMPLEMENTED + TESTED | `mcp-discovery.test.ts`, `tool-governance.test.ts`, `client-races.test.ts` §58 — hash mismatch → `POLICY_REVIEW_REQUIRED` + disabled, before any side effect; proven live in the demo's Flow 4 |
| Tool disable vs. execution race | IMPLEMENTED + TESTED | `client-races.test.ts` §57 — the connector's own `execute()` re-checks live `enabled` state from the store immediately before any MCP call, so a disable landing between Gate authorization and execution is honored |
| Offboarding vs. action-submission race | IMPLEMENTED + TESTED | `client-races.test.ts` §102 — `beginOffboarding` and `assertActionEligible` are both CAS/transaction-protected; an eligibility check racing a concurrent offboarding transaction never lets a new action through once offboarding has committed |
| MCP process cleanup (no orphans) | IMPLEMENTED + TESTED | host-level: `mcp-gateway.test.ts` process-leak test (5 cycles, every pid confirmed dead); container-level: `client-gateway-container.test.ts` (`docker top` confirms exactly one process — the gateway itself — after repeated real discovery cycles, and none at all after `docker stop`) |
| MCP malformed/hang/crash handling | IMPLEMENTED + TESTED | `mcp-gateway.test.ts` — malformed response → `MCP_PROTOCOL_ERROR`; hang → bounded timeout + forced kill, never an indefinite wait; crash mid-call → `MCP_INDETERMINATE`, never a fabricated success (TNA-48) |
| Client bypass assessment | IMPLEMENTED + TESTED | `computeBypassAssessment()`, `packages/client-schema` — originally a test-local duplicate never exported from any package (found and corrected in this closeout); now real, exported, and exercised by its own 4 tests in `bypass-assessment.test.ts` against the actual shipped function |
| Historical config/snapshot integrity | IMPLEMENTED + TESTED | `client_actions` is INSERT-only by construction (no `UPDATE` path exists anywhere in `ClientStore`); proven directly by recording a snapshot, changing the tenant's integration config afterward, and confirming the recorded row is unchanged while a fresh hash differs (`client-store.test.ts` §23/67, added in this closeout) |
| MCP executable-path validation on Windows | IMPLEMENTED + TESTED | found broken during this closeout (real Windows paths like `C:\Program Files\nodejs\node.exe` were rejected outright); fixed with a precise heuristic (space accepted only inside genuine path structure) that still rejects `bash -c evil`-shaped inputs; both directions proven in `mcp-registration.test.ts` |

## Packaged-Execution Closure (post-closeout — TNA-64)

The gap identified above — `apps/tna-client-gateway/src/main.ts` did not construct/wire a
`PlatformFacade` — was closed in a dedicated follow-up review. See
`docs/client-integration/client-integration-v0.1-packaged-path-closure.md` for the full account
(original behavior, why library/demo proof was insufficient, the fix, and exhaustive packaged-binary
verification). Scored here with the same strict vocabulary:

| Item | Status | Evidence |
|---|---|---|
| Production composition root wires the real PlatformFacade | IMPLEMENTED + TESTED | `apps/tna-client-gateway/src/governed-execution.ts` (new) constructs the real Gate/ExecutionBroker/SentinelRuntime/PlatformStore/Ledger/PlatformLedgerDispatcher composition from `main.ts`, exactly mirroring `apps/tna-platform/src/main.ts`'s own accepted pattern; `main.ts` now fails closed (process exits before `server.listen`) if this construction throws |
| Standalone RECORDED fallback removed from the production path | IMPLEMENTED + TESTED | `createClientGatewayServer` refuses to construct with `mode: 'governed'` and no `platformFacadeFor` (throws at startup, not per-request); `record-only` mode requires explicit `CLIENT_GATEWAY_MODE=record-only` and `config.ts` refuses it outright when `NODE_ENV=production` — proven by `client-gateway-packaged-path.test.ts`'s production-fail-closed test |
| Real packaged-binary HTTP proof (not manually instantiated in-process) | IMPLEMENTED + TESTED | `client-gateway-packaged-path.test.ts` spawns `dist/apps/tna-client-gateway/src/main.js` as a real OS process and drives it over real TCP HTTP for every scenario below |
| Gate ALLOW proven through the packaged binary | IMPLEMENTED + TESTED | resource-pattern-matching request → `gate_decision.decision === 'ALLOW'` read directly from the real `PlatformStore` file, not inferred from HTTP `state` alone |
| Gate BLOCK proven through the packaged binary | IMPLEMENTED + TESTED | out-of-pattern resource → real Gate `BLOCK` ("Undeclared resource or operation"); `capability_id`/`sentinel_session_id` both confirmed `null` — Capability/Sentinel/MCP structurally never engaged |
| Sentinel prevention proven through the packaged binary | IMPLEMENTED + TESTED | a real `SentinelRuntime.activateStop()` (accepted admin API, applied directly to the gateway's own live Sentinel store file) TERMINATEs the session pre-action; Gate is confirmed `ALLOW` (proving Sentinel, not Gate, stopped it) and `result_hash` is confirmed `null` |
| Real MCP invocation through the packaged binary | IMPLEMENTED + TESTED | `result_hash` presence on the real `PlatformStore` record is only reachable after a genuine initialize→tools/call→result round trip with the real fixture process; the packaged smoke test (`npm run smoke:client-integration:v01`) additionally prints `MCP INVOKED` only after this same evidence is checked |
| Ledger evidence through the packaged binary | IMPLEMENTED + TESTED | real `Ledger.getStream()` against the gateway's own Ledger SQLite file (host test) and against a `docker cp`'d snapshot of the container's data volume (container test) both confirm a `PLATFORM_ACTION_COMPLETED` event with matching `tenant_id`/`correlation_id`/`authority_context.tool` |
| End-to-end correlation preserved | IMPLEMENTED + TESTED | `client_action_id` is threaded through `platformRequest.metadata` and confirmed to survive into the stored platform request; `platform_action_id`/`correlation_id` are now returned in the client HTTP response (previously `correlation_id` was silently dropped — fixed in this closure) |
| Authenticated tenant binding (body `tenant_id` cannot redirect) | IMPLEMENTED + TESTED | the packaged ALLOW test submits a spoofed body `tenant_id` alongside the real credential and confirms the resulting `PlatformStore` record is bound to the authenticated tenant, never the spoofed one — the field is not read anywhere in `handleClientRoute` |
| Cross-tenant rejection through the packaged binary | IMPLEMENTED + TESTED | Tenant A's real credential against Tenant B's real `tool_id` → `404 NOT_FOUND` before the platform is ever reached; Tenant B's `PlatformStore` list contains no action attributable to Tenant A's agent |
| Schema-drift rejection through the packaged binary | IMPLEMENTED + TESTED | a real rediscovery (H1→H2, same registered server, via a mode-file-driven MCP wrapper) genuinely changes the tool's schema hash and disables it; the next real HTTP submission is refused (`409 TOOL_NOT_ENABLED`) before Gate is ever reached |
| Suspension/offboarding through the packaged binary | IMPLEMENTED + TESTED | ACTIVE → real COMPLETED action; SUSPENDED → `409 TENANT_NOT_ACTIVE`; OFFBOARDED (revoked credential) → `401`; the pre-suspension COMPLETED action remains reconstructible via direct `PlatformStore`/`reconstructPlatformAction` access (the trusted-operator path) |
| Production missing-facade fail-closed | IMPLEMENTED + TESTED | `NODE_ENV=production` + `CLIENT_GATEWAY_MODE=record-only` → non-zero exit before the HTTP server ever listens, with a diagnosable stderr reason; a positive control confirms `NODE_ENV=production` alone (governed mode, the default) starts and reports `governed_execution: true` on `/ready` |
| Containerized governed execution | IMPLEMENTED + TESTED | `client-gateway-container.test.ts` (extended): a full onboarding + governed action completes entirely inside the container, with Gate/Capability/Sentinel/result-hash/Ledger evidence all verified from real `docker cp`'d snapshots of the container's own data volume |
| MCP child cleanup (packaged/containerized) | IMPLEMENTED + TESTED | container: `docker top` shows exactly the gateway process plus the one intentionally-cached, reused governed-execution MCP client (never an orphan) after repeated discovery cycles, and none at all after `docker stop`; the cached client is reaped by the same `shutdownMcpClients()` call already proven at the host level (`mcp-gateway.test.ts`'s process-leak test) |
| Restart/reconstruction | IMPLEMENTED (via existing accepted semantics; not independently re-tested in this closure) | `PlatformStore`/`Ledger`/`ClientStore` are all plain SQLite files opened fresh on each process start — no in-memory-only state the gateway itself owns; a restarted gateway process reads the same files and reconstructs identically, the same restart discipline Volumes 8-9 already proved for `apps/tna-platform`. This closure did not add a dedicated packaged-binary restart test — see "Remaining Limitations" in the closure document |
| A genuine principal-role defect found and fixed by this closure | — | `handleClientRoute` originally passed a `servicePrincipal` (role `platform-service`) to `platformFacade.submitAndRun`; `PlatformGateOrchestrator.authorize`/`PlatformExecutionOrchestrator.run` both unconditionally require role `platform-agent` — every real governed submission through the packaged path would have failed Gate authorization even with a facade wired. Found only by actually calling the packaged HTTP endpoint; fixed by switching to `agentPrincipal`. A second defect (Gate's `agent.id` pattern rejects `:`, and the original `client:<serviceId>` agent id violated it) was found and fixed the same way |

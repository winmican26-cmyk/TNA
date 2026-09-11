# TNA Platform Integration v0.1 Requirement Matrix

Scored against section-126 acceptance gate. Every item is IMPLEMENTED and TESTED unless noted.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Existing 535 tests remain green | IMPLEMENTED, TESTED | 579/579 total, two consecutive `npm run check` runs |
| 2 | `PlatformActionRequest` v1 implemented | IMPLEMENTED, TESTED | `packages/platform-schema`; `validatePlatformActionRequestInput` rejects unknown/runtime-owned fields explicitly |
| 3 | Tenant/action identity implemented | IMPLEMENTED, TESTED | `platform_action_id`, `correlation_id` runtime-assigned at `RECEIVED`; `(tenant_id, request_id)` idempotency |
| 4 | Explicit state machine implemented | IMPLEMENTED, TESTED | 13 states, `ALLOWED_TRANSITIONS` table, `isAllowedTransition` enforced on every write |
| 5 | CAS/state-version transitions implemented | IMPLEMENTED, TESTED | `state_version` + `UPDATE ... WHERE state_version=?` on every mutation; proven with genuine concurrent races |
| 6 | Gate integrated | IMPLEMENTED, TESTED | `GateActionAdapter`/`PlatformGateOrchestrator` against the real, accepted `Gate` class |
| 7 | BLOCK prevents execution | IMPLEMENTED, TESTED | no transition path from `BLOCKED`; proven via unit, orchestration, and HTTP tests |
| 8 | HOLD prevents execution | IMPLEMENTED, TESTED | same, for `HELD` |
| 9 | ALLOW leads to capability | IMPLEMENTED, TESTED | `AUTHORIZED -> CAPABILITY_ISSUED` via real `ExecutionBroker.issue()` |
| 10 | Capability bound to exact action/input | IMPLEMENTED, TESTED | `input_hash` bound at `RECEIVED`, re-verified before every redemption; white-box drift test |
| 11 | Sentinel session starts before execution | IMPLEMENTED, TESTED | `CAPABILITY_ISSUED -> MONITORING` strictly precedes `claimExecution` |
| 12 | Sentinel pre-action decision enforced | IMPLEMENTED, TESTED | `TOOL_CALL_REQUESTED` submitted and evaluated before any `redeem()` call; TERMINATE/HOLD both proven to block execution |
| 13 | Sentinel terminate enforced | IMPLEMENTED, TESTED | confirmed and unconfirmed termination both proven, with correct `TERMINATED`/`INDETERMINATE` split |
| 14 | Broker-mediated connector execution only | IMPLEMENTED, TESTED | connectors are `ToolRegistry` handlers; `ToolRegistry.invoke()` is broker-only by Gate's own design, proven |
| 15 | VAD optional routing explicit | IMPLEMENTED, TESTED | `requires_verification: false` skips VAD entirely; no fabricated acceptance |
| 16 | Required VAD path works | IMPLEMENTED, TESTED | real `VadVerificationAdapter`, ACCEPTED path proven in demo Flow 4 and against real VAD in `platform-auditor-integration.test.ts` |
| 17 | VAD rejection cannot become completed success | IMPLEMENTED, TESTED | REJECTED -> FAILED, ESCALATED -> INDETERMINATE, proven for all three verdicts |
| 18 | Ledger end-to-end evidence works | IMPLEMENTED, TESTED | `PlatformLedgerDispatcher`; correlation-scoped reconstruction proven |
| 19 | Transactional outbox implemented | IMPLEMENTED, TESTED | `packages/platform-outbox` + `PlatformStore implements OutboxPort` |
| 20 | Outbox retry idempotent | IMPLEMENTED, TESTED | deterministic `event_id`; Ledger's own idempotent `append()` |
| 21 | Crash/restart outbox recovery proven | IMPLEMENTED, TESTED | real store close/reopen, `DELIVERING -> FAILED` recovery, demo Flow 5 |
| 22 | Bounded dead-letter behavior exists | IMPLEMENTED, TESTED | `maxAttempts` (default 8), `DEAD_LETTER` never reclaimed |
| 23 | Auditor can assess completed action | IMPLEMENTED, TESTED | correlation-scoped `TNA_BASELINE_V01` assessment, real `AuditorRuntime` |
| 24 | Full action reconstruction exists | IMPLEMENTED, TESTED | `reconstructPlatformAction`; `GET /actions/:id/evidence` |
| 25 | Action request idempotency exists | IMPLEMENTED, TESTED | `(tenant_id, request_id)` uniqueness, same-content replay vs. different-content CONFLICT |
| 26 | Double execution claim prevented | IMPLEMENTED, TESTED | CAS `claimExecution`, genuine concurrent race test |
| 27 | Terminate/complete race tested | IMPLEMENTED, TESTED | genuine concurrent race, exactly one winner |
| 28 | Hold/execute race tested | IMPLEMENTED, TESTED | stale-version execution claim rejected |
| 29 | Concurrent outbox dispatch tested | IMPLEMENTED, TESTED | two dispatchers racing one record, exactly one delivery |
| 30 | Restart persistence tested | IMPLEMENTED, TESTED | `platform-state.test.ts`, `platform-outbox.test.ts`, demo Flow 5 |
| 31 | Tenant isolation tested | IMPLEMENTED, TESTED | `(tenant_id, ...)`-scoped queries throughout; cross-tenant NOT_FOUND/FORBIDDEN |
| 32 | Connector registry exists | IMPLEMENTED, TESTED | `ConnectorRegistry`, tenant-scoped |
| 33 | Arbitrary connector injection blocked | IMPLEMENTED, TESTED | trusted-startup-only registration; unknown tool fails closed |
| 34 | Real HTTP API exists | IMPLEMENTED, TESTED | `createPlatformServer`, section-44 route set |
| 35 | Real HTTP integration tests exist | IMPLEMENTED, TESTED | 9 tests, real TCP server + `fetch` |
| 36 | Secrets protected | IMPLEMENTED, TESTED | `findSecretShapedField` on request `input`/`metadata` at validation time |
| 37 | Requests/results bounded | IMPLEMENTED, TESTED | `MAX_INPUT_BYTES`, `MAX_METADATA_BYTES`, `MAX_BODY_BYTES` |
| 38 | List queries paginated | IMPLEMENTED, TESTED | `GET /actions` bounded, `MAX_ACTION_PAGE_SIZE` enforced |
| 39 | Demo success works | IMPLEMENTED, TESTED | Flow 1 |
| 40 | Demo block works | IMPLEMENTED, TESTED | Flow 2 |
| 41 | Demo Sentinel containment works | IMPLEMENTED, TESTED | Flow 3 (genuine mid-flight revocation, not a synthetic trigger) |
| 42 | Demo VAD works | IMPLEMENTED, TESTED | Flow 4 |
| 43 | Demo outbox recovery works | IMPLEMENTED, TESTED | Flow 5 |
| 44 | Demo Auditor integration works | IMPLEMENTED, TESTED | Flow 6 |
| 45 | Threat model complete | IMPLEMENTED | `platform-threat-model-v0.1.md`, 30 categories |
| 46 | Requirement matrix complete | IMPLEMENTED | this document |
| 47 | Proof of work complete | IMPLEMENTED | `proof-of-work-platform-v0.1.md` |
| 48 | Check passes twice | IMPLEMENTED, TESTED | two consecutive clean `npm run check` runs, 579/579 both times |
| 49 | No frontend | CONFIRMED | none built |
| 50 | No cloud deployment | CONFIRMED | none attempted |
| 51 | No billing | CONFIRMED | none attempted |
| 52 | No unrelated feature expansion | CONFIRMED | scope limited to sections 1-132 of the Volume 8 brief |

## Known partial / explicitly out of scope

- **MCP support (sections 59-63)**: boundary interface only (`McpToolConnector`), no working local MCP
  server fixture — explicitly marked "optional but preferred" in the brief; documented in
  `platform-mcp-boundary-v0.1.md` as a deliberate scope decision, not a silent gap.
- **Cross-catalog Auditor compatibility**: the platform emits its own `PLATFORM_*` Ledger event types
  rather than additionally re-emitting Gate/Sentinel/VAD's native event types, so Auditor's existing
  v0.1 control catalog typically returns `INSUFFICIENT_EVIDENCE` (not `PASS`) for a platform-orchestrated
  action — documented in `platform-ledger-integration-v0.1.md` and `platform-auditor-integration-v0.1.md`,
  within section 92's explicit allowance not to require PASS.
- **Runtime observation depth (section 24)**: pre-action and one post-action observation are wired;
  the synchronous, non-isolated connector execution model in v0.1 has no long-running in-flight window
  for further mid-execution observations (`NETWORK_REQUEST`, `PROCESS_STARTED`, etc.) — none are
  fabricated, and none are claimed as covered.
- **`ToolInputRegistry` passthrough for non-`demo.deploy.execute` tools**: a discovered constraint of
  the accepted, closed `ExecutionBroker` — documented in `platform-gate-integration-v0.1.md`, not
  worked around by modifying accepted code.

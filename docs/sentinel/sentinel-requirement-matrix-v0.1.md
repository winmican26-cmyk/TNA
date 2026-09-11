# TNA Sentinel v0.1 Requirement Matrix

Scored against the Volume 6 acceptance gate (section 126). Status language: IMPLEMENTED, TESTED,
PARTIAL, NOT IMPLEMENTED, NOT APPLICABLE (section 116).

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | All existing 250 tests remain green | TESTED | `npm run check` ×2, 392/392 total (see verification doc for one transient, unrelated flake observed and re-verified away) |
| 2 | Sentinel session model exists | IMPLEMENTED, TESTED | `packages/sentinel-schema`, `packages/sentinel-runtime` |
| 3 | Strict observation model exists | IMPLEMENTED, TESTED | `validateObservationInput`, 23 controlled types, controlled sources |
| 4 | Runtime-owned observation sequencing exists | IMPLEMENTED, TESTED | sequence assigned inside the append transaction; concurrency + reset-attempt tests |
| 5 | Source identity binding exists | IMPLEMENTED, TESTED | `SOURCE_ALLOWED_OBSERVATION_TYPES`, `assertCanObserve`, impersonation tests |
| 6 | Deterministic Sentinel policy exists | IMPLEMENTED, TESTED | `packages/sentinel-policy`, hash computed by Sentinel, never trusted from caller |
| 7 | Deterministic rule engine exists | IMPLEMENTED, TESTED | `packages/sentinel-signals` (20 pure evaluators), `packages/sentinel-engine` |
| 8 | Deterministic severity exists | IMPLEMENTED, TESTED | fixed `SEVERITY_SCORE` map, no AI |
| 9 | Deterministic decision precedence exists | IMPLEMENTED, TESTED | TERMINATE > HOLD > WARN > CONTINUE, monotonic accumulator |
| 10 | Authority expiry detected | IMPLEMENTED, TESTED | `AUTHORITY_EXPIRED`, signal + runtime-level tests |
| 11 | Agent revocation detected | IMPLEMENTED, TESTED | `AGENT_REVOKED`, flow C, race test |
| 12 | Policy drift detected | IMPLEMENTED, TESTED | `POLICY_CHANGED`, flow D, race test |
| 13 | Tool drift detected | IMPLEMENTED, TESTED | `TOOL_NOT_ALLOWED`, flow B |
| 14 | Operation drift detected | IMPLEMENTED, TESTED | `OPERATION_NOT_ALLOWED` |
| 15 | Resource drift detected | IMPLEMENTED, TESTED | `RESOURCE_NOT_ALLOWED`, separator-safety test |
| 16 | Destination drift detected | IMPLEMENTED, TESTED | `DESTINATION_NOT_ALLOWED`, `REDIRECT_NOT_ALLOWED` |
| 17 | Input hash mismatch detected | IMPLEMENTED, TESTED | `TOOL_INPUT_HASH_MISMATCH` |
| 18 | Capability mismatch detected | IMPLEMENTED, TESTED | `CAPABILITY_CONTEXT_MISMATCH` |
| 19 | Runtime limit enforced from Sentinel-owned clock | IMPLEMENTED, TESTED | `RUNTIME_EXCEEDED`, injected-clock tests |
| 20 | Cost limit runtime-owned | IMPLEMENTED, TESTED | `session_cost` aggregate, NaN/Infinity/negative dropped |
| 21 | Call/request/process counters runtime-owned | IMPLEMENTED, TESTED | `tool_call_count`/`network_request_count`/`process_spawn_count`, all three volumetric rules tested |
| 22 | Heartbeat rule implemented if claimed | IMPLEMENTED, TESTED | `MISSING_HEARTBEAT`, optional per session |
| 23 | HOLD works | IMPLEMENTED, TESTED | explicit `hold()` + rule-triggered HOLD, flow D |
| 24 | TERMINATE works | IMPLEMENTED, TESTED | explicit `terminate()` + rule-triggered TERMINATE, flow B |
| 25 | Terminate idempotent | IMPLEMENTED, TESTED | 3 consecutive calls → 1 containment call |
| 26 | Resume is trusted-only | IMPLEMENTED, TESTED | controller/admin only; reader rejected (unit, abuse-case, HTTP) |
| 27 | Containment uncertainty cannot report success | IMPLEMENTED, TESTED | `INDETERMINATE` path, flow E |
| 28 | Emergency stop implemented | IMPLEMENTED, TESTED | session/agent/tenant scopes |
| 29 | Emergency stop persisted | IMPLEMENTED, TESTED | `sentinel_stops` table, restart-persistence test |
| 30 | Emergency stop tenant isolated | IMPLEMENTED, TESTED | cross-tenant stop-isolation test |
| 31 | Sentinel state durable across restart | IMPLEMENTED, TESTED | session/counters/violations/decisions/stop restart test |
| 32 | Concurrency tested | TESTED | 10 concurrent observations → 10 unique sequences; concurrent terminating violations |
| 33 | Role separation tested | IMPLEMENTED, TESTED | observer/reader/controller/admin, each boundary tested |
| 34 | Source impersonation blocked | IMPLEMENTED, TESTED | see #5 |
| 35 | Tenant isolation tested | IMPLEMENTED, TESTED | session/observation/stop cross-tenant tests |
| 36 | Secrets rejected | IMPLEMENTED, TESTED | fixed secret-shape detector, same principle as accepted Ledger |
| 37 | Payloads bounded | IMPLEMENTED, TESTED | `MAX_OBSERVATION_PAYLOAD_BYTES` |
| 38 | List queries paginated | IMPLEMENTED, TESTED | bounded `listViolations`/`listDecisions`, cursor traversal |
| 39 | HTTP API authenticated | IMPLEMENTED, TESTED | bearer-only, 11 fixed credentials |
| 40 | HTTP suite exercises real server | TESTED | `tests/sentinel/sentinel-http.test.ts`, real TCP + fetch, 23 tests, participates in `npm run check` |
| 41 | Gate adapter exists | IMPLEMENTED, TESTED | `GateAuthorityRevalidator`, 4 dedicated tests against a real `Gate` |
| 42 | Containment/broker adapter exists or limitation documented | IMPLEMENTED (documented limitation), TESTED | `ExecutionBrokerContainmentAdapter` always reports unconfirmed; see containment model doc |
| 43 | Ledger adapter exists | IMPLEMENTED, TESTED | `SentinelLedgerAdapter`, proven against the real `Ledger` facade |
| 44 | Ledger evidence can represent Sentinel activity | IMPLEMENTED, TESTED | 10 new `SENTINEL_*` event types, additive Ledger-schema extension |
| 45 | Demo normal flow passes | TESTED | Flow A |
| 46 | Demo tool-drift termination passes | TESTED | Flow B |
| 47 | Demo revocation passes | TESTED | Flow C |
| 48 | Demo policy-drift hold passes | TESTED | Flow D |
| 49 | Demo containment-uncertainty flow passes | TESTED | Flow E |
| 50 | Check passes twice consecutively | TESTED | see verification doc |
| 51 | Threat model complete | IMPLEMENTED | `sentinel-threat-model-v0.1.md`, 28 categories |
| 52 | Rule catalog complete | IMPLEMENTED | `sentinel-rule-catalog-v0.1.md`, all 20 rule types |
| 53 | Requirement matrix complete | IMPLEMENTED | this document |
| 54 | Proof-of-work complete | IMPLEMENTED | `proof-of-work-sentinel-v0.1.md` |
| 55 | No frontend built | NOT APPLICABLE | out of scope by design |
| 56 | No Auditor built | NOT APPLICABLE | out of scope by design |
| 57 | No ML anomaly engine built | NOT APPLICABLE | out of scope by design; every rule is deterministic |
| 58 | No unrelated scope expansion | NOT APPLICABLE | scope held to runtime observation, rule evaluation, decisions, containment, emergency stop, Gate/broker/Ledger integration |

## Known partial/limitation items (not blockers, documented honestly)

| Area | Status | Detail |
|---|---|---|
| Execution-broker/isolation-runner real containment | PARTIAL (documented, not silent) | the accepted broker/runner expose no external cancel/abort surface; `ExecutionBrokerContainmentAdapter` honestly reports unconfirmed rather than fabricating success |
| Observation freshness/reordering | PARTIAL | sequence is trustworthy once persisted; producer-side delay or reorder before submission is not detected |
| DNS rebinding | NOT MITIGATED (by design) | `PRIVATE_NETWORK_DESTINATION` only classifies addresses it is given, same limitation as the accepted `egress-guard` |
| Missing instrumentation | NOT MITIGATED (fundamental) | an uninstrumented action path is invisible to every rule; documented as TNA-28/29 |
| Sentinel-specific reconstruction view | NOT IMPLEMENTED | session narrative is reconstructible from existing queries + Ledger events; a dedicated reconstruction API is future work (section 102 permits this) |
| Compromised host / compromised Sentinel process | NOT APPLICABLE (by design) | explicitly not claimed to be mitigated |
| Privileged database rewrite | NOT APPLICABLE (by design) | identical posture to the accepted Ledger |

## Mandatory blockers remaining: 0

Every item in the acceptance-gate checklist (section 126) that is in scope for Volume 6 is
IMPLEMENTED and TESTED, or NOT APPLICABLE by design. The items above are documented scope boundaries,
not failures of a required item.

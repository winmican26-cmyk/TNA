# TNA Client Integration & MCP Gateway v0.1 Proof of Work

## Accepted Baseline

- Volume 1–3 — TNA Gate v0.1–v0.3
- Volume 4 — VAD Engine v0.1
- Volume 5 — TNA Ledger v0.1
- Volume 6 — TNA Sentinel v0.1
- Volume 7 — TNA Auditor v0.1
- Volume 8 — TNA Platform Integration v0.1
- Volume 9 — TNA Deployment Engineering v0.1

All nine remain untouched. No accepted tag was moved or rewritten.

## Git State

- Branch: `trust-no-agent-main`
- This milestone's work is currently uncommitted in the working tree, presented for review before any
  commit/tag step, per the workflow established by every prior volume.

## Files Created

```
packages/client-schema/{package.json,src/index.ts}
packages/client-core/{package.json,src/index.ts}
packages/mcp-schema/{package.json,src/index.ts}
packages/mcp-gateway/{package.json,src/index.ts}
apps/tna-client-gateway/{package.json,src/{index,config,connectors,server,main,governed-execution}.ts}
scripts/fixtures/mcp-fixture-server.ts
scripts/demo-client-integration-v01.ts
scripts/smoke-client-integration-v01.ts
tests/client-integration/{mcp-gateway,client-store,client-races,client-offboarding,
  credential-rotation,cross-tenant,mcp-registration,mcp-discovery,tool-governance,
  bypass-assessment,client-abuse-cases,client-gateway-container,client-gateway-packaged-path}.test.ts
docs/client-integration/{client-integration-overview-v0.1,tenant-model-v0.1,
  service-identity-model-v0.1,credential-lifecycle-v0.1,mcp-gateway-v0.1,mcp-transport-v0.1,
  governed-tool-model-v0.1,tool-discovery-v0.1,tool-risk-model-v0.1,tool-policy-binding-v0.1,
  tool-schema-drift-v0.1,client-action-model-v0.1,client-health-v0.1,onboarding-readiness-v0.1,
  client-onboarding-runbook-v0.1,mcp-operations-runbook-v0.1,client-offboarding-runbook-v0.1,
  client-integration-threat-model-v0.1,client-integration-verification-v0.1,
  client-integration-requirement-matrix-v0.1,proof-of-work-client-integration-v0.1,
  client-integration-principles-v0.1,client-integration-v0.1-packaged-path-closure}.md
```

## Files Modified

- `package.json` / `package-lock.json` — added `demo:client-integration:v01`, `start:client-gateway`,
  and `smoke:client-integration:v01` scripts; lockfile regenerated (`npm install`) to register the four
  new workspace packages so `npm ci` (used by the Docker build) succeeds — see "Failing-First Defects
  Found."
- `apps/tna-client-gateway/src/{config,connectors,server,main}.ts` — packaged-execution closure: real
  `mode`/fail-closed config validation, an additive `into` parameter on `buildToolRegistry` for
  incremental multi-tenant registration, the `servicePrincipal`→`agentPrincipal` and agent-id-shape
  fixes, and real composition-root wiring — see
  `client-integration-v0.1-packaged-path-closure.md` for the full account.
- `tests/client-integration/client-gateway-container.test.ts` — extended in place (same test count) to
  additionally prove governed execution inside the real container.
- `README.md` — Volume 10 status line updated to note the packaged-execution closure.

No accepted Gate/VAD/Ledger/Sentinel/Auditor/Platform/Deployment file was modified.

## Client Integration Architecture

Four packages plus one app, consolidated deliberately:

- **client-schema** (194 lines) — `ClientTenant`, `ClientServiceIdentity`, credential issuance/hashing/
  verification, risk/readiness/bypass vocabulary (including `computeBypassAssessment`, promoted from a
  test-local duplicate to a real exported function during this closeout), secret detection,
  canonicalization, pagination utilities. No I/O.
- **client-core** (493 lines) — `ClientStore` (SQLite, WAL, CAS): tenants (5-state lifecycle, atomic
  offboarding cascade), service identities (create/rotate/revoke/authenticate), MCP server
  registrations (register/reconfigure/status), governed tools (discovery reconciliation, enable/
  disable), policy bindings, client action records, integration config snapshots.
- **mcp-schema** (212 lines) — MCP error codes (9 values), server registration validation (shell-
  injection defense in depth, Windows-path-aware — see "Failing-First Defects Found"), governed tool
  types, deterministic risk classification table, schema hashing, discovered-tool validation. No I/O.
- **mcp-gateway** (212 lines) — `McpStdioClient`: real stdio JSON-RPC 2.0 (initialize,
  notifications/initialized, tools/list, tools/call), child process with `shell:false`/explicit argv/
  bounded env allowlist, per-phase timeout enforcement, SIGTERM→SIGKILL shutdown, INDETERMINATE on
  crash, process cleanup.
- **apps/tna-client-gateway** (896 lines across `config.ts`/`connectors.ts`/`server.ts`/`main.ts`) — the
  HTTP composition root: `server.ts` implements the full admin API (tenant/service/MCP-server/discover/
  enable/disable/suspend/offboard/health/readiness) and a client action API
  (`POST /v1/client/actions` etc.) with an *optional* `platformFacade` dependency; `connectors.ts`
  adapts a governed MCP tool into a `ToolConnector` the same way `apps/tna-platform/src/connectors.ts`
  does; `main.ts` is the actual packaged entrypoint — see "Failing-First Defects Found" for the one real
  gap found in it during this closeout.

## MCP Fixture Server

`scripts/fixtures/mcp-fixture-server.ts` — a standalone, dependency-free Node script speaking the
actual minimal MCP stdio wire protocol. Eight behavior modes controlled by `MCP_FIXTURE_MODE` (six from
the original submission, two — `oversized-result` and `echo-env` — added during this closeout to close
real test-coverage gaps):

| Mode | Behavior |
|---|---|
| `normal` | Two tools (crm.lookup_customer, crm.update_customer), correct protocol |
| `schema-v2` | Same tools, crm.lookup_customer's schema drifted (added required field) |
| `malformed` | tools/list responds with non-JSON |
| `hang` | tools/call never responds |
| `crash-on-call` | Accepts tools/call, then exits |
| `crash-immediately` | Exits before reading any message |
| `oversized-result` | tools/call responds with a result far larger than `MAX_MCP_RESULT_BYTES` |
| `echo-env` | Advertises `env.echo`, whose call returns the *child's own* `process.env[name]` — proves environment isolation against a real process, not an assertion about parent intent |

## Responsibility Boundaries

- **client-schema** has no I/O, no imports from client-core/mcp-gateway/mcp-schema
- **mcp-schema** has no I/O, no imports from client-core/mcp-gateway/client-schema
- **client-core** imports client-schema and mcp-schema; owns all SQLite I/O
- **mcp-gateway** imports mcp-schema; owns all child-process I/O
- **The gateway package itself** (`mcp-gateway`) still has no HTTP surface and is not directly
  client-facing — this part of the original submission's claim was accurate and remains so. What was
  *not* accurate (corrected during this closeout, see the requirement matrix's §30 entry) is the broader
  claim that Volume 10 as a whole had "no HTTP surface" — `apps/tna-client-gateway/src/server.ts` is a
  real, tested HTTP surface; it simply sits in front of the gateway package, never bypassing it.

## Tenant Model

5-state lifecycle (PENDING → ACTIVE → SUSPENDED → ACTIVE / OFFBOARDING → OFFBOARDED), CAS-protected,
offboarding cascade atomically revokes all service identities/tools/servers. See
`tenant-model-v0.1.md`.

## Service Identity Model

4 roles (agent-client, tool-provider, operator, read-only-auditor), credential issuance with one-time
token return, SHA-256 hash storage, atomic rotation with no dual-valid window, authentication via hash
lookup. See `service-identity-model-v0.1.md`.

## Credential Lifecycle

Issue → hash → store-hash-only → authenticate-via-hash → rotate-or-revoke. No plaintext persistence.
Rotation is atomic (one UPDATE replaces the hash). See `credential-lifecycle-v0.1.md`.

## MCP Gateway

Real stdio JSON-RPC 2.0 client. shell:false, explicit argv, bounded env allowlist, per-phase timeouts,
SIGTERM→SIGKILL shutdown, INDETERMINATE on crash. See `mcp-gateway-v0.1.md` and
`mcp-transport-v0.1.md`.

## Governed Tool Model

UUID-based identity (not name-based), 5 review statuses, operator-only enablement, no auto-enable,
deterministic risk classification table, schema hashing. See `governed-tool-model-v0.1.md`.

## Tool Discovery and Reconciliation

New → DISCOVERED, drift → POLICY_REVIEW_REQUIRED (disabled), removed → REMOVED (disabled). Full
reconciliation in one transaction. See `tool-discovery-v0.1.md`.

## Tool Risk Classification

Deterministic table, no LLM, no self-classification, no trust from MCP description/annotations. See
`tool-risk-model-v0.1.md`.

## Tool Policy Binding

Policy bound at enable time, schema_hash included in policy_hash, append-only binding history. See
`tool-policy-binding-v0.1.md`.

## Schema Drift Detection

Hash comparison during discovery, immediate disable and POLICY_REVIEW_REQUIRED, re-review required.
See `tool-schema-drift-v0.1.md`.

## Client Action Model

Config snapshot at submission (proven immutable — see "Real Container Verification" and the threat
model's §21 entry), tenant eligibility check, UUID-based tool reference. See
`client-action-model-v0.1.md`.

## HTTP API

`apps/tna-client-gateway/src/server.ts` — two authentication domains: the admin API
(`TNA_CLIENT_ADMIN_TOKEN` bearer) and the client API (service-identity bearer, resolved via
`ClientStore.authenticateService`, tenant derived from the authenticated identity — never from the
request body, section 37). Proven against a real running Docker container over real HTTP (see below).

## Real Container Verification

`tests/client-integration/client-gateway-container.test.ts` builds the actual production image (the
same `deploy/docker/Dockerfile` Volume 9 built — both apps already ship in the one image's `dist/apps/*`,
so no new Dockerfile was needed) and overrides its entrypoint to start `apps/tna-client-gateway` instead
of `apps/tna-platform`. Proven, against a real running container:

- **Non-root**: `docker exec <container> id -u` != 0.
- **Readiness**: real `/live`/`/ready` HTTP checks.
- **Real admin HTTP API**: tenant creation, MCP server registration, and MCP tool discovery all driven
  over real HTTP against the real container.
- **Real MCP child-process execution inside the container**: the fixture server is `docker cp`'d into
  the running container (deliberately not shipped in the production image — no test fixtures in a
  runtime image, Volume 9 discipline) and a real discovery call spawns a real child process inside the
  container's own PID namespace.
- **No orphaned MCP child processes**: after several repeated discovery cycles, `docker top` shows
  exactly one process (the gateway itself) — every spawned child was cleanly reaped.
- **Real graceful shutdown**: `docker stop` sends a genuine SIGTERM to PID 1; the container exits 0 and
  its logs show `Graceful shutdown complete`; after stop, `docker top` against the container fails
  entirely — there is no host-visible process left over.

**Honest scope note**: this suite proves the onboarding/admin surface and real MCP discovery inside a
real container. It does not exercise a governed client action through the packaged binary, because
`main.ts` does not yet wire a `platformFacade` — see "Failing-First Defects Found."

## CAS Discipline

`state_version` on tenants, service identities, MCP servers, governed tools. `UPDATE ... WHERE
state_version=?` on every mutation. CONFLICT on concurrent modification. Proven under real races
(credential rotation vs. request, tool enable/disable, tool-disable vs. execution, schema-drift vs.
execution, offboarding vs. action submission) in `client-races.test.ts`.

## Tenant Isolation

Every `ClientStore` query is `(tenant_id, ...)`-scoped. No unscoped query exists. Authentication
resolves to the identity's own `tenant_id`. Every meaningful cross-tenant reference (credential, tool,
action, MCP server, service identity, colliding tool names across tenants) is attempted and rejected in
`cross-tenant.test.ts`.

## Secret Handling

`findSecretShapedField` applied to all metadata before persistence. Same algorithm as platform-schema
and deployment-schema — §145: a fixed rule set, not general DLP. Environment isolation for spawned MCP
child processes (a distinct concern — what the *child process* can see, not what gets persisted) is
proven separately: an unallowlisted secret is genuinely invisible to a real spawned child
(`mcp-gateway.test.ts`, added during this closeout).

## Resource Bounds

`MAX_MCP_SERVERS_PER_TENANT` (10), `MAX_TOOLS_PER_SERVER` (200), `MAX_TOOL_SCHEMA_BYTES` (32KB),
`MAX_MCP_RESULT_BYTES` (128KB, now proven — see "Failing-First Defects Found"), `MAX_NAME_LENGTH` (200),
`MAX_METADATA_BYTES` (4KB), `MAX_CLIENT_PAGE_SIZE` (200), executable (500 chars), arg (2000 chars), env
name (128 chars).

## Failure / INDETERMINATE Semantics

Carried forward from every prior milestone: `MCP_INDETERMINATE` on crash mid-call is a first-class,
honestly-reported result. Never silently upgraded to a guessed success, never blindly retried (TNA-48).

## Threat Model

29 threat categories in `client-integration-threat-model-v0.1.md` (26 from the original submission + 3
added during this closeout's consistency pass — MCP child-process environment leakage, MCP result-size
exhaustion, and the packaged-entrypoint facade-wiring gap), covering all threats listed in §115 plus the
§116 (MCP server is external code) and §117 (client environment bypass) limitations stated prominently.

## Failing-First Defects Found

Real defects caught by actually running against the real Docker daemon, real MCP child processes, and
real Windows paths — not assumed correct from inspection. Preserved here in the order they were found,
across two review passes (initial verification, then the closeout's own threat-model consistency pass):

**Initial verification pass** (5 lint issues, then 4 real defects):

1. **5 lint errors** — unused imports/parameters in `apps/tna-client-gateway/src/connectors.ts` and
   three test files. Trivial cleanup, no behavior change.
2. **Nested SQLite transaction** — `ClientStore.beginOffboarding()` called `this.tx(() =>
   this.transitionTenant(...))`, and `transitionTenant` itself opened its own transaction — SQLite has
   no nested transactions (`cannot start a transaction within a transaction`), so every offboarding-
   related test failed. Fixed by splitting a transaction-free `transitionTenantInTx` core that
   `beginOffboarding` calls inside its own single transaction, with `transitionTenant` as a thin
   tx-wrapped public version for standalone callers.
3. **Windows executable-path validation false positive** — the original `EXECUTABLE_PATTERN` rejected
   any path containing a space, which broke on Windows (`process.execPath` is typically `C:\Program
   Files\nodejs\node.exe`). Fixed with a precise heuristic: a space is accepted only when it sits inside
   genuine path structure (a `/`, `\`, or drive letter); a bare `"word word"` with no path structure
   (`bash -c evil`, `a b`) is still rejected. Verified the existing shell-injection test suite (which
   explicitly expected bare-space rejection) still passes under the new rule.
4. **Internally inconsistent demo Gate envelope** — `scripts/demo-client-integration-v01.ts`'s
   `action_bindings[].outcome` strings never matched anything in `objective.allowed_outcomes`, and
   `resources.files.read` was empty while the read tool's binding declared `operation: 'read'`. Fixed
   both so Gate's own envelope schema validation and authorization logic are internally consistent.
5. **`package-lock.json` workspace drift** — the four new workspace packages weren't registered in the
   lockfile, so `npm ci` (used by the Docker build) failed immediately with "Missing from lock file"
   errors. Fixed by running `npm install` once to regenerate the lock file.

**Closeout threat-model consistency pass** (found while re-reading the implementation against its own
threat-model claims, real-container verification, and the review's explicit checklist):

6. **`MCP_RESULT_TOO_LARGE` had zero test coverage anywhere** — the bound was correctly implemented in
   `mcp-gateway`, but no test in the entire suite exercised it. Closed with a real oversized MCP
   response (`oversized-result` fixture mode) proving the bound is actually enforced, not merely present
   in the source.
7. **MCP child-process environment isolation had zero test coverage anywhere** — `buildChildEnv()` was
   correctly implemented, but nothing proved an unallowlisted secret is genuinely invisible to a real
   spawned child (as opposed to merely "not intentionally passed"). Closed with two real tests: a secret
   set in the gateway's own `process.env` but not allowlisted is reported as `null` by a real child
   process asked to read it back; an explicitly allowlisted variable does arrive.
8. **Test-assertion bug in the new environment-isolation test itself** — the first draft of the "secret
   does not leak" test double-`JSON.stringify`'d the child's response and then substring-matched for the
   unescaped text `"value":null`, which can never appear literally once JSON-encoded twice (it appears
   escaped, as `\"value\":null`). The underlying product behavior was already correct (confirmed with a
   standalone debug script before touching the test); the test itself was wrong. Fixed by parsing the
   nested JSON properly instead of fragile string matching.
9. **`computeBypassAssessment` existed only as a test-local duplicate, never exported from any
   package** — `bypass-assessment.test.ts` defined its own 4-line copy of the KNOWN_BYPASS/
   NO_KNOWN_BYPASS/UNKNOWN decision logic; no production code anywhere could actually call it. Fixed by
   promoting it to a real, exported function in `packages/client-schema`, and updating the test suite to
   import and exercise the actual shipped function.
10. **Missing regression coverage for config-snapshot immutability** — the threat model claimed a
    recorded client action's `config_snapshot_hash` "is never retroactively changed," which was true by
    construction (`client_actions` is INSERT-only — no `UPDATE` path exists) but had no test proving it.
    Closed with a real test: record a snapshot, genuinely change the tenant's integration config
    afterward, confirm the recorded row is unaffected while a fresh hash computation differs.
11. **Real architectural gap found, not fixed under this closeout's scope**: `apps/tna-client-gateway/
    src/main.ts` (the packaged production entrypoint) does not construct or pass a `platformFacade` into
    `createClientGatewayServer` — a deployed instance's `POST /v1/client/actions` therefore runs only the
    honestly-labeled `state: 'RECORDED'` standalone mode, not the real governed-execution path
    `server.ts` fully supports and the demo script proves works. This was deliberately **not** fixed
    during this closeout (verification and documentation only, no new wiring under time pressure right
    before a review) — it is recorded here, in the threat model (category 29), and in the requirement
    matrix's "Closeout Review Corrections" section as a real, open, BLOCKED/PARTIAL item for a future
    closure pass.

All eleven were root-caused by comparing expected vs. observed output from real execution — real Docker
containers, real child processes, real Windows paths — not by inspection.

**Packaged-execution closure pass** (a dedicated follow-up review scoped to close exactly defect #11
above — see `client-integration-v0.1-packaged-path-closure.md` for the full account):

12. **Wrong principal role in the packaged HTTP path** — `handleClientRoute` passed a `servicePrincipal`
    (role `platform-service`) to `platformFacade.submitAndRun`. Both `PlatformGateOrchestrator.authorize`
    and `PlatformExecutionOrchestrator.run` unconditionally require a tenant-bound `platform-agent`
    principal — every real governed submission through the packaged path would have failed Gate
    authorization outright, even after a `PlatformFacade` was wired. Found by actually submitting through
    the real compiled binary over real HTTP (the demo script never hit this because it used the correct
    principal type from the start, at the library level, never through `server.ts`'s own code path).
    Fixed by switching to `agentPrincipal(agentId, tenantId, agentId)`.
13. **Gate-rejected agent id shape** — immediately after fixing #12, the next real submission failed
    Gate's own envelope schema validation: the chosen `agentId` (`` `client:${serviceId}` ``) contains a
    colon, which Gate's `agent.id` pattern (`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) rejects. Fixed by using
    the bare `service_id` (already `svc_<uuid>`, globally unique) as the Gate-facing agent identity.

Both were only reachable by actually constructing a real HTTP request against the real compiled binary
with a real service credential — no prior review's evidence chain had ever done that, which is exactly
the gap TNA-64 (see `client-integration-principles-v0.1.md`) now names and closes.

## Existing Regression Results

All 662 previously-accepted tests (Volumes 1–9) remain green — verified as part of the 757-test
full-suite run, not in isolation.

## Client Integration Test Results

95 new tests across 13 files in `tests/client-integration/` (88 from the original closeout + 7 from the
packaged-execution closure's new `client-gateway-packaged-path.test.ts`; `client-gateway-container.test.ts`
was extended in place, not given new tests, so its count is unchanged):

| File | Tests |
|---|---|
| `bypass-assessment.test.ts` | 8 |
| `client-abuse-cases.test.ts` | 11 |
| `client-gateway-container.test.ts` | 1 |
| `client-gateway-packaged-path.test.ts` | 7 |
| `client-offboarding.test.ts` | 6 |
| `client-races.test.ts` | 7 |
| `client-store.test.ts` | 10 |
| `credential-rotation.test.ts` | 4 |
| `cross-tenant.test.ts` | 6 |
| `mcp-discovery.test.ts` | 6 |
| `mcp-gateway.test.ts` | 10 |
| `mcp-registration.test.ts` | 6 |
| `tool-governance.test.ts` | 13 |
| **Total new** | **95** |

## Total Test Reconciliation

662 (accepted baseline) + 88 (original closeout's new client-integration tests) + 7 (packaged-execution
closure's new tests) = **757**. Node's test runner reported exactly 757 tests, 757 passed, 0 failed, in
both consecutive `npm run check` runs — no estimation.

## First Clean Run

```
npm run check → 757 tests, 757 pass, 0 fail
Typecheck: PASS
Lint: PASS
Build: PASS
```

## Second Clean Run (Repeatability, no cleanup between runs)

```
npm run check → 757 tests, 757 pass, 0 fail
```

## Demo Output

```
npm run demo:client-integration:v01
```

All six required flows genuinely computed against real Gate/Sentinel/Ledger-adjacent library code and a
real spawned MCP fixture process — Flow 1 (Client Onboarding: tenant → service identity → MCP server →
real discovery → risk classification → policy binding → tool enablement → activation), Flow 2 (Governed
Read: real Gate ALLOW → capability → Sentinel CONTINUE → real MCP tool call → COMPLETED), Flow 3
(Blocked Write: real Gate BLOCK, MCP call count 0), Flow 4 (Schema Drift: real rediscovery with a
genuinely changed schema → POLICY_REVIEW_REQUIRED, tool disabled, new action rejected), Flow 5
(Suspension: new action rejected, historical evidence retained), Flow 6 (Offboard: credentials revoked,
tools disabled, MCP servers disabled, new request rejected, historical evidence preserved). Run twice
for repeatability with identical results.

## Packaged-Execution Closure — Additional Verification

A dedicated follow-up review closed the one blocker left open above (Failing-First Defects Found #11).
Full account: `docs/client-integration/client-integration-v0.1-packaged-path-closure.md`. Summary of new
evidence, all against the real compiled binary, never an in-process handler:

- `apps/tna-client-gateway/src/governed-execution.ts` (new) is the real production composition root —
  Gate/ExecutionBroker/SentinelRuntime/PlatformStore/Ledger wired from the same accepted classes
  `apps/tna-platform/src/main.ts` uses, with a per-tenant, per-request `syncGovernedTenant()` step that
  re-derives Gate's agent/envelope from live `ClientStore` state (tools enable/disable/drift-driven
  changes take effect immediately, never a stale startup-time snapshot).
- `apps/tna-client-gateway/src/main.ts` now fails closed: it constructs the governed integration
  unconditionally in governed mode and lets a construction failure propagate — the process exits before
  `server.listen` is ever reached.
- `apps/tna-client-gateway/src/config.ts` adds `CLIENT_GATEWAY_MODE` (`governed`/`record-only`,
  default `governed`); `record-only` is refused outright when `NODE_ENV=production`.
- `tests/client-integration/client-gateway-packaged-path.test.ts` (7 tests, real spawned processes, real
  HTTP): governed ALLOW with real Ledger evidence and correlation/tenant-binding proof, Gate BLOCK,
  Sentinel prevention via a real emergency stop, cross-tenant rejection, schema-drift rejection,
  suspension/offboarding boundaries, and production fail-closed startup.
- `tests/client-integration/client-gateway-container.test.ts` extended in place: a full governed action
  now completes inside the real container, verified against a `docker cp`'d snapshot of the container's
  own data volume.
- `npm run smoke:client-integration:v01` (new): drives the compiled binary through one governed flow and
  prints `CLIENT AUTHENTICATED` / `TENANT RESOLVED` / `PLATFORM ACTION CREATED` / `GATE ALLOW` /
  `SENTINEL CONTINUE` / `MCP INVOKED` / `LEDGER EVIDENCE FOUND` / `ACTION COMPLETED`, each line gated on
  real evidence, not assumed.
- **TNA-64 — The Packaged Path Is the Real Path** (`client-integration-principles-v0.1.md`) is the
  permanent principle this closure established.

## Remaining Limitations

- **Binary attestation** for MCP servers is not implemented (§116 limitation).
- **MCP server internal behavior** is outside TNA's observation boundary (§116).
- **Client environment integrity** is not guaranteed by TNA (§117).
- **General DLP** is not provided — only fixed-rule secret detection (§114).
- **Packaged-binary restart/reconstruction was not independently re-tested** in the packaged-execution
  closure — `PlatformStore`/`Ledger`/`ClientStore` are plain SQLite files with no gateway-owned in-memory
  state, the same restart discipline Volumes 8-9 already proved for `apps/tna-platform`'s identical
  pattern, but no dedicated packaged-binary kill/restart/reconstruct test (analogous to
  `deployment-shutdown.test.ts`) was added. A future pass should add one rather than relying on the
  analogy alone.
- **Bare (non-containerized) packaged-binary SIGTERM proof is POSIX-only**, matching the established
  precedent in `deployment-shutdown.test.ts` (`child.kill('SIGTERM')` force-terminates on native Windows
  without running the JS shutdown handler — a Node/Windows platform limitation). The cross-platform,
  authoritative proof is the real `docker stop` in `client-gateway-container.test.ts`.
- **The Sentinel-prevention proof uses a real emergency stop, not a naturally-triggered rule match** —
  judged the most deterministic real trigger reachable through HTTP alone; still a genuine real-Sentinel
  proof, via `activateStop()`'s own accepted admin API, not a mocked `SentinelPort`.
- No frontend, no cloud deployment, no billing — all correctly out of scope.

## Requirement Scorecard

Full item-by-item scoring against all 160 sections of the Volume 10 specification, plus both closure
passes' own stricter checklists, is in
`docs/client-integration/client-integration-requirement-matrix-v0.1.md`. Summary: every in-scope
mandatory item is IMPLEMENTED + TESTED, or explicitly DOCUMENTED_LIMITATION / NOT_APPLICABLE by design.
The one item previously scored BLOCKED / PARTIAL — governed execution through the packaged production
entrypoint — is now IMPLEMENTED + TESTED, closed by the packaged-execution closure (see the requirement
matrix's own "Packaged-Execution Closure" section).

## Mandatory Blockers Remaining

**0**

The architectural gap the prior closeout left open (main.ts facade wiring) has been closed and verified
through the real compiled production binary — not merely documented as acceptable to defer.

## Final Git Status

Branch `trust-no-agent-main`. All Volume 10 files (four packages, `apps/tna-client-gateway` including
`governed-execution.ts`, the MCP fixture, the demo script, the smoke script, 13 test files, 23 docs) are
committed in the accepted implementation commit (see "Architectural Acceptance" below); `package.json`
and `package-lock.json` were modified in the same commit (additive: new scripts, new workspace packages
registered). No accepted Gate/VAD/Ledger/Sentinel/Auditor/Platform/Deployment file was deleted or
destructively modified; `main` and all nine prior accepted tags are untouched. `output/` (pre-existing,
unrelated to Volume 10) was never staged.

## Recommendation

> **READY FOR ARCHITECTURAL ACCEPTANCE REVIEW**

This section is preserved as the implementation agent's own recommendation at the time it was written —
see "Architectural Acceptance" below for the actual acceptance decision and its evidence.

## Architectural Acceptance

Status:
ARCHITECTURALLY ACCEPTED AS TNA CLIENT INTEGRATION & MCP GATEWAY v0.1
WITH DOCUMENTED SCOPE AND LIMITATIONS

Accepted implementation commit:
57e63e9643376c27c1ff77b9f5298f0fa16b5e45

Accepted tag:
tna-client-integration-v0.1

Tag target:
57e63e9643376c27c1ff77b9f5298f0fa16b5e45

Accepted test baseline:
757 / 757

Repeatability:
Two consecutive npm run check runs passed.

Demo:
npm run demo:client-integration:v01 — 6 / 6 PASS

Packaged smoke:
npm run smoke:client-integration:v01 — PASS

Real packaged binary:
PASS

Real MCP process:
PASS

Containerized governed execution:
PASS

Mandatory blockers remaining:
0

### Documented scope and limitations (preserved, not erased)

- MCP server code itself is not inherently trusted (§116) — TNA mediates the interface (tool, arguments,
  policy, timeouts, honest error reporting); it does not audit, sandbox, or certify the MCP server
  binary, and cannot observe or control what happens inside that process.
- TNA cannot guarantee complete mediation if a client retains parallel credentials or direct network
  access to the governed system (§117, the client-environment-bypass limitation) — `computeBypassAssessment`
  makes this an explicit, auditable attestation rather than an implicit assumption, but cannot itself
  detect a bypass it isn't told about.
- MCP execution has only the runtime observation depth actually implemented — no binary attestation, no
  MCP-internal behavioral monitoring beyond the protocol boundary.
- Client-hosted/single-host remains the concrete v0.1 deployment baseline — the same posture Volume 9
  established for `apps/tna-platform`, not HA, not multi-region.
- No SaaS hosting layer exists yet.
- No billing.
- No customer frontend.
- No enterprise SSO/SCIM.
- No Kubernetes/multi-region infrastructure.
- No claim of regulatory certification (no ISO 27001, SOC 2, NIST, EU AI Act, DORA, HIPAA, GDPR, NIS2, or
  PCI DSS status is claimed).
- No claim that protocol compatibility implies tool safety — a server correctly speaking MCP's wire
  protocol has made no claim about what its tools actually do.
- **Packaged-path closure note**: a dedicated packaged-binary restart/reconstruction regression was not
  added in the packaged-execution closure; restart durability relies on already-accepted Platform/
  Deployment persistence semantics (`PlatformStore`/`Ledger`/`ClientStore` are plain SQLite files with no
  gateway-owned in-memory state, the same discipline Volumes 8-9 already proved for `apps/tna-platform`'s
  identical pattern). This is *not* a newly and independently proven packaged-binary restart property —
  it is an inference from an already-accepted pattern, recorded here exactly that way so it is never
  mistaken for a dedicated test result.

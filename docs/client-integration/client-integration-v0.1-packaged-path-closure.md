# TNA Client Integration & MCP Gateway v0.1 — Packaged-Execution Closure

A focused follow-up review, scoped to exactly one mandatory architectural blocker the prior
architectural-review closeout found and left open: the packaged production entrypoint
(`apps/tna-client-gateway/src/main.ts`) never wired governed execution. No new client features, no
redesign of the client gateway — only what was required to close this one gap and prove it closed
through the real, compiled production binary. See `docs/client-integration/client-integration-principles-v0.1.md`
for the permanent principle this closure established (**TNA-64 — The Packaged Path Is the Real Path**).

## Original Behavior

`apps/tna-client-gateway/src/server.ts` fully supported an optional `platformFacade` dependency:
when present, `POST /v1/client/actions` flowed through the real Gate → Capability → Sentinel →
ExecutionBroker → MCP-connector path; when absent, it recorded the action in the client store only,
honestly labeled `state: 'RECORDED'`. `apps/tna-client-gateway/src/main.ts` — the actual packaged
production entrypoint — never constructed or passed a `platformFacade`. Every deployed instance
therefore ran the non-governed `RECORDED` path unconditionally, regardless of intent.

## Why Library/Demo Proof Was Insufficient

`scripts/demo-client-integration-v01.ts` and the library-level test suite (`client-races.test.ts`,
`tool-governance.test.ts`, and others) proved the Gate→Capability→Sentinel→Broker→MCP path works
correctly — but every one of those proofs constructs its own Gate/Sentinel/PlatformStore/ExecutionBroker
instances directly, in-process, exactly the way a hand-rolled test harness would. None of them ever
started the compiled `dist/apps/tna-client-gateway/src/main.js` binary and submitted a request to it
over real HTTP. The packaged entrypoint's own composition root was therefore never actually exercised —
a correct library and a correct demo do not imply a correctly wired production binary, and in this case
they did not: the binary was wired to skip governance entirely.

## Security / Assurance Risk

A client integrating against a real deployed instance of this gateway would receive `201` responses with
`client_action_id` and `config_snapshot_hash` fields that look identical in shape to a governed response,
but with `state: 'RECORDED'` — no Gate decision, no capability, no Sentinel session, no MCP call, no
Ledger evidence beyond the client-side record. A client that did not carefully check for the
`platform_action_id` field's absence could reasonably believe every one of its actions was being
governed when none of them were.

## Production Composition-Root Fix

`apps/tna-client-gateway/src/governed-execution.ts` (new) is the real composition root, built from the
same accepted classes `apps/tna-platform/src/main.ts` already uses for its own single-tenant deployment
(`Gate`, `ExecutionBroker`, `SentinelRuntime`, `PlatformStore`/`PlatformGateOrchestrator`/
`PlatformExecutionOrchestrator`/`PlatformFacade`, `Ledger`/`PlatformLedgerDispatcher`) — nothing
reimplemented. The one genuine difference from `tna-platform`'s composition: the client gateway serves
many tenants whose enabled-tool set changes at runtime, so `syncGovernedTenant(tenantId, agentId)`
re-derives that tenant's Gate agent registration and envelope — and re-syncs its connector/tool
registrations — from *live* `ClientStore` state immediately before every governed submission, rather
than binding a fixed envelope once at startup the way `tna-platform`'s single fixed demo agent does.
`buildTenantGateEnvelope()` computes the envelope's `tools.allow`, `action_bindings`, and
`resources.files.{read,write}` directly from each enabled tool's own policy binding
(`allowed_operations`, `resource_patterns` — bound at `enableTool` time), so there is no separate
allow-list to keep in sync by hand: a tool that is not enabled is simply absent from the envelope, and
Gate blocks it on its own authority.

`apps/tna-client-gateway/src/main.ts` now calls `buildGovernedIntegration()` unconditionally in governed
mode (the default) and passes its `platformFacadeFor`/`syncGovernedTenant` into
`createClientGatewayServer`.

### A genuine defect found while wiring this

The very first real HTTP submission through the newly-wired packaged binary failed. `handleClientRoute`
was constructing a `servicePrincipal` (role `platform-service`) and passing it to
`platformFacade.submitAndRun` — but both `PlatformGateOrchestrator.authorize` and
`PlatformExecutionOrchestrator.run` unconditionally require a tenant-bound `platform-agent` principal
(`if (principal.role !== 'platform-agent' || !principal.agentId) throw ...`). Every governed submission
through the packaged path would have failed Gate authorization outright, even with a facade correctly
wired. Fixed by switching to `agentPrincipal(agentId, tenantId, agentId)`.

A second, related defect surfaced immediately after: the chosen `agentId` (`` `client:${serviceId}` ``)
contains a colon, which Gate's own envelope schema rejects (`agent.id` must match
`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) — every real submission failed Gate's schema validation before
authorization logic ever ran. Fixed by using the bare `service_id` (already `svc_<uuid>`, globally
unique) as the Gate-facing agent identity.

Neither defect was reachable by the prior closeout's proof, because nothing in that closeout's evidence
chain ever constructed an `agentPrincipal`/`servicePrincipal` through the packaged HTTP surface — the
demo script already used the correct principal type from the start, at the library level, so the bug
only existed in `server.ts`'s own code path and was invisible until that exact code path was exercised.

## Production Fail-Closed Semantics

`apps/tna-client-gateway/src/config.ts` adds `mode: 'governed' | 'record-only'`
(`CLIENT_GATEWAY_MODE`, default `governed`). `record-only` is refused outright at config-load time —
before anything durable is touched — when `NODE_ENV=production`. `createClientGatewayServer` itself
additionally refuses to construct a server declaring `mode: 'governed'` without a `platformFacadeFor`
resolver, so there is no code path by which "governed" can end up behaving like "record-only" at
runtime. `main.ts` constructs the governed integration unconditionally when `config.mode === 'governed'`
and lets a construction failure propagate — the process exits before `server.listen` is ever called, so
there is no window in which a partially-wired server accepts requests.

`record-only` mode is retained for development/testing only, requires the explicit environment variable,
and every place it can end up serving a request is labeled, in code comments and in the HTTP response
itself, as providing **no governed execution assurance whatsoever**.

## Packaged Binary Verification

`tests/client-integration/client-gateway-packaged-path.test.ts` (7 tests) spawns
`dist/apps/tna-client-gateway/src/main.js` as a real, separate OS process for every scenario and drives
it over real TCP HTTP — never an in-process handler construction:

- **Governed ALLOW path** — real onboarding through the real admin API, a real MCP discovery, a real
  governed action reaching `COMPLETED`; verified by opening the gateway's own real `PlatformStore` file
  directly and confirming `gate_decision.decision === 'ALLOW'`, a real `capability_id`, a real
  `sentinel_session_id`, and a real `result_hash` — never inferred from the HTTP `state` field alone.
  Also proves a body-supplied `tenant_id` cannot redirect execution away from the authenticated tenant,
  and that `client_action_id` survives end-to-end into the platform request's metadata (correlation
  preservation).
- **Gate BLOCK path** — an enabled tool requested outside its bound resource pattern is blocked by real
  Gate policy ("Undeclared resource or operation"); `capability_id`/`sentinel_session_id` both confirmed
  `null`, proving Capability/Sentinel/MCP never engaged.
- **Sentinel prevention** — a real `SentinelRuntime.activateStop()` call (the accepted admin API,
  applied directly to the gateway's own live Sentinel store file) TERMINATEs the session before the MCP
  fixture is ever invoked; Gate is confirmed `ALLOW` (proving Sentinel, not Gate, is what stopped it).
- **Cross-tenant rejection** — Tenant A's real credential against Tenant B's real `tool_id` → real
  `404 NOT_FOUND`, before the platform is ever reached.
- **Schema-drift rejection** — a real rediscovery of the *same* registered MCP server (via a mode-file-
  driven wrapper that changes the fixture's effective schema between two real `/discover` calls without
  ever touching the server's registered `executable`/`args`) genuinely changes the schema hash and
  disables the tool; the next real submission is refused before Gate is ever reached.
- **Suspension/offboarding boundaries** — ACTIVE works, SUSPENDED and OFFBOARDED are both rejected, and
  the pre-suspension COMPLETED action remains reconstructible via direct `PlatformStore`/
  `reconstructPlatformAction` access (the trusted-operator path).
- **Production fail-closed** — `NODE_ENV=production` + `CLIENT_GATEWAY_MODE=record-only` refuses to
  start (non-zero exit, diagnosable stderr); governed mode (the default) starts normally in production.

`npm run smoke:client-integration:v01` additionally drives the compiled binary through one full governed
flow and prints exactly: `CLIENT AUTHENTICATED`, `TENANT RESOLVED`, `PLATFORM ACTION CREATED`,
`GATE ALLOW`, `SENTINEL CONTINUE`, `MCP INVOKED`, `LEDGER EVIDENCE FOUND`, `ACTION COMPLETED` — each line
printed only after the evidence for it has actually been checked against the real running process.

## Container Verification

`tests/client-integration/client-gateway-container.test.ts` was extended (not duplicated) to drive a
full governed action entirely inside the real container: tenant/service/MCP-server onboarding, a real
containerized MCP discovery, tool enablement, activation, and a real client action submission over real
HTTP into the containerized process — reaching `COMPLETED`. Evidence is pulled out with a full-directory
`docker cp` of the container's `/data` volume (base SQLite files together with their `-wal`/`-shm`
sidecars, since every store here runs WAL mode) and verified with the real `PlatformStore`/`Ledger`
reader classes. The existing orphan-process check was updated from "exactly one node process" to
"exactly two" — the gateway itself, plus the one intentionally-cached, reused MCP client the governed
connector deliberately keeps alive across calls (`connectors.ts`'s `clientCache`) — and the existing
clean-SIGTERM-shutdown proof (`docker stop`, exit 0, no process list left over) is unchanged and still
covers this cached client's reaping via `shutdownMcpClients()`.

## Tenant Isolation Proof

Cross-tenant rejection is proven both at the packaged-binary level (above) and, structurally, by the
same `ClientStore.getTool(tenantId, toolId)` tenant-scoping every prior closure already verified —
this closure adds no new isolation mechanism, only a new real-HTTP proof that the existing mechanism
still holds once a `PlatformFacade` sits behind it.

## Gate / Sentinel / MCP / Ledger Proof

Covered exhaustively above under "Packaged Binary Verification" and "Container Verification" — every one
of Gate ALLOW, Gate BLOCK, Sentinel TERMINATE, real MCP invocation, and real Ledger evidence is proven
against real durable state, not inferred from a single HTTP response field.

## Tests

- `tests/client-integration/client-gateway-packaged-path.test.ts` — 7 new tests (all spawn the real
  compiled binary).
- `tests/client-integration/client-gateway-container.test.ts` — extended in place (test count unchanged:
  1), now additionally proving governed execution inside the real container.
- `scripts/smoke-client-integration-v01.ts` — a new operational smoke script (`npm run
  smoke:client-integration:v01`), not counted as a `node --test` test.

Total new test count for this closure: **7**. Combined with the packaged-execution closure's baseline of
750 (662 accepted + 88 from the prior closeout), the full suite now totals **757 / 757**.

## Remaining Limitations

- **Restart/reconstruction was not independently re-tested for the packaged binary in this closure.**
  `PlatformStore`/`Ledger`/`ClientStore` are all plain SQLite files opened fresh on each process start,
  with no in-memory-only state the gateway itself owns — the same restart discipline Volumes 8-9 already
  proved for `apps/tna-platform`'s identical pattern — but this closure did not add a dedicated
  packaged-binary kill/restart/reconstruct test analogous to `deployment-shutdown.test.ts`. A future pass
  should add one rather than relying on the analogy alone.
- **SIGTERM proof for the bare (non-containerized) packaged binary is POSIX-only**, matching the
  established precedent in `tests/deployment/deployment-shutdown.test.ts`: `child.kill('SIGTERM')` on
  native Windows force-terminates the process without running its JS shutdown handler at all (a Node/
  Windows platform limitation). The authoritative, cross-platform graceful-shutdown proof is the real
  `docker stop` in `client-gateway-container.test.ts`, which now also covers the governed path.
- **The Sentinel-prevention test uses a real emergency stop, not a naturally-triggered rule match.**
  Triggering `TOOL_NOT_ALLOWED`/`RUNTIME_EXCEEDED`/`COST_EXCEEDED` organically through the pre-action
  `TOOL_CALL_REQUESTED` observation was judged impractical to construct deterministically through HTTP
  alone (those rules compare the observation against values the session itself was created from, so they
  cannot diverge under a single well-formed request). `activateStop()` is itself a real, accepted,
  admin-only Sentinel operation — not a mocked `SentinelPort` — so this remains a genuine proof of real
  Sentinel prevention, just via a different (and equally real) trigger than a rule match.
- All limitations recorded in the prior closeout (§116 malicious-MCP-server boundary, §117 client-
  environment-bypass boundary, no binary attestation, fixed-rule-set secret detection only) are
  unchanged by this closure.

This closure adds no new client-facing features and modifies no accepted Gate/VAD/Ledger/Sentinel/
Auditor/Platform/Deployment component.

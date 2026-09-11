# TNA Principles TNA-64 (Volume 10 — TNA Client Integration & MCP Gateway v0.1, Packaged-Execution Closure)

TNA-01 through TNA-57 are preserved unchanged — TNA-51 through TNA-57 are documented in
`docs/deployment/deployment-principles-v0.1.md`; earlier ones remain documented inline within their own
respective volumes' docs. Volume 10's original submission reserved but did not mint TNA-58 through
TNA-63; nothing in this document claims them, and nothing here supersedes or restates any prior
principle.

The following principle was established by the Volume 10 packaged-execution closure — a real
architectural gap found by actually exercising the compiled production binary, not by inspecting source.

## TNA-64 — The Packaged Path Is the Real Path

A control proven only in a library, a demo script, or a test harness that constructs its own handler
in-process is not a deployed control. The actual production entrypoint must instantiate and enforce the
same governed path the architecture claims — Client Gateway → Client Action Handler → PlatformFacade →
Platform Action → Gate → Capability → Sentinel → Execution Broker → MCP Connector → MCP Server → Ledger
— or the deployed system provides none of the assurance its design documents describe.

Established by the discovery that `apps/tna-client-gateway/src/main.ts`, the packaged production
entrypoint, never constructed or passed a `PlatformFacade` into `createClientGatewayServer` — despite
`server.ts` fully supporting one, and despite `scripts/demo-client-integration-v01.ts` and the library-
level test suite proving the underlying Gate→Capability→Sentinel→Broker→MCP path worked correctly. A
deployed instance's `POST /v1/client/actions` therefore ran only the honestly-labeled `state: 'RECORDED'`
standalone mode — never real governed execution — and no test anywhere had actually started the compiled
binary and submitted a governed action through it over real HTTP. That gap survived an entire
architectural review pass (the closeout that preceded this one) precisely because "proven at the library
level" was allowed to stand in for "proven through the packaged binary."

Closing it surfaced a second, more serious finding of the same shape: even after wiring a
`PlatformFacade` into the composition root, the first real submission through the packaged HTTP endpoint
failed. `handleClientRoute` was passing a `servicePrincipal` (role `platform-service`) to
`platformFacade.submitAndRun`, and both `PlatformGateOrchestrator.authorize` and
`PlatformExecutionOrchestrator.run` unconditionally require a tenant-bound `platform-agent` principal.
Every governed submission through the packaged path would have failed Gate authorization outright — a
defect invisible to every prior review because nothing had ever actually called the endpoint end to end
with a real HTTP request and a real service credential.

**How to apply**: for any TNA subsystem with both a packaged production entrypoint and a library/demo
proof of its governed path, treat the packaged entrypoint as untested until a real test spawns the
compiled binary as a separate process, drives it over real network I/O with real credentials, and
inspects real durable evidence (not just the HTTP response's own reported status) for every claimed
control point. A composition root that can silently omit a mandatory dependency and still start
successfully is itself a defect — see the fail-closed startup discipline this closure also added
(`apps/tna-client-gateway/src/config.ts`'s `mode` validation, `main.ts`'s unconditional exit on governed-
integration construction failure).

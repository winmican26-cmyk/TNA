# TNA Principles TNA-58 – TNA-64 (Volume 10 — TNA Client Integration & MCP Gateway v0.1)

TNA-01 through TNA-57 are preserved unchanged — TNA-51 through TNA-57 are documented in
`docs/deployment/deployment-principles-v0.1.md`; earlier ones remain documented inline within their own
respective volumes' docs. Nothing in this document supersedes or restates any prior principle.

TNA-58 through TNA-63 were reserved but not written up at the time of Volume 10's original submission;
each is backed by a real, already-implemented, already-tested mechanism from that submission, extracted
into a permanent principle at freeze time — not new work. TNA-64 was established separately, by the
subsequent packaged-execution closure (`client-integration-v0.1-packaged-path-closure.md`) — a real
architectural gap found by actually exercising the compiled production binary, not by inspecting source.

## TNA-58 — Discovery Does Not Grant Authority

Finding out that a tool exists is not the same as being allowed to use it. Established by governed-tool
discovery always landing in the `DISCOVERED` review status with `enabled: false` and `risk_class: null`
— no code path in `ClientStore.recordDiscovery` auto-enables a newly discovered tool, regardless of how
trustworthy its MCP server otherwise appears. An operator must explicitly classify risk and bind policy
(`enableTool`) before a discovered tool can ever be invoked. Proven in `mcp-discovery.test.ts`,
`tool-governance.test.ts`, and Flow 1 of `scripts/demo-client-integration-v01.ts`.

## TNA-59 — External Tool Identity Must Be Stable

A tool's platform-facing identity must never be derived from data an external, untrusted MCP server
controls. Established by `toolPlatformId(tool_id)` (`mcp.<tool_id>`, `tool_id` a runtime-minted
`gt_<uuid>`) being the identity Gate, the execution broker, and Ledger all key on — never
`external_tool_name`, which the MCP server itself supplies and could reuse or collide across servers.
Two MCP servers advertising a tool of the same name produce two distinct governed tools with two
distinct platform identities; a malicious server cannot impersonate another server's tool merely by
naming its own tool the same thing. Proven in `mcp-registration.test.ts` and `tool-governance.test.ts`.

## TNA-60 — Schema Drift Is Authority Drift

A tool's input schema is part of what was actually reviewed and approved — if the schema changes, the
approval no longer describes the tool. Established by `recordDiscovery`'s automatic hash comparison on
every rediscovery: a schema-hash mismatch immediately disables the tool and marks it
`POLICY_REVIEW_REQUIRED`, fail-closed, with no execution permitted under the stale policy. Proven at the
library level (`mcp-discovery.test.ts`, `client-races.test.ts` §58, Flow 4 of the demo) and, as of the
packaged-execution closure, through the real packaged HTTP binary itself
(`client-gateway-packaged-path.test.ts`'s schema-drift test: a real rediscovery of the same registered
server changes the effective schema and the very next real HTTP submission is refused before Gate is
ever reached).

## TNA-61 — Client Credentials Define the Real Enforcement Boundary

TNA's authorization only covers the path that actually goes through it — a client that also holds a
separate, direct credential to the same external system has a real bypass TNA cannot see or prevent.
Established by `computeBypassAssessment()` (`packages/client-schema`): the one deterministic place an
operator's attestation about this exact limitation becomes an auditable `KNOWN_BYPASS` /
`NO_KNOWN_BYPASS` / `UNKNOWN` value, with `externalDirectCredential: true` always winning — a known
bypass can never be reported as clean high-assurance mediation merely because everything else looks fine.
Proven in `bypass-assessment.test.ts`; the underlying limitation itself is documented in the threat
model's §117 section.

## TNA-62 — Offboarding Must Revoke Future Power Without Erasing History

Ending a client relationship must make every future consequential action impossible while leaving the
record of what already happened intact. Established by `ClientStore.beginOffboarding`'s atomic cascade
— service-identity revocation, tool disablement, and MCP-server disablement all commit in the same
transaction as the tenant's `OFFBOARDING` transition — combined with `client_actions` being INSERT-only
by construction (no `UPDATE` code path exists anywhere in `ClientStore`) and `PlatformStore`/`Ledger`
records surviving the cascade untouched. Proven in `client-offboarding.test.ts`, `client-races.test.ts`
§102, Flow 6 of the demo, and — through the real packaged HTTP binary — the suspension/offboarding test
in `client-gateway-packaged-path.test.ts`, which confirms the pre-offboarding `COMPLETED` action remains
reconstructible via direct `PlatformStore`/`reconstructPlatformAction` access after offboarding
completes.

## TNA-63 — Protocol Compatibility Does Not Imply Trust

A server that correctly speaks MCP's wire protocol has made no claim whatsoever about what its tools
actually do. TNA validates and enforces the *interface* — handshake correctness, schema shape, bounded
results, honest timeout/crash reporting — never the *behavior* behind it. This is the load-bearing
reason TNA still requires deterministic, operator-supplied risk classification (`classifyRisk`) rather
than trusting an MCP server's own tool descriptions or annotations, and why §116 of the threat model
states plainly that a malicious MCP server could execute arbitrary code, make arbitrary network
requests, or lie about its own capabilities — all while remaining fully protocol-compliant. Proven by
the risk-classification table itself never reading from `description`/`annotations` fields
(`tool-governance.test.ts`) and by the malformed/crash/hang handling in `mcp-gateway.test.ts` — a
protocol-compliant server and a hostile one are handled by exactly the same bounded, fail-closed
mechanism.

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

# TNA Pilot Deployment v0.1 — Overview

Scope: one controlled staging/pilot deployment topology for external customer/funder demonstration.
This is an **operational deployment-closure pass**, not a new volume. No accepted control semantics,
accepted tags, or accepted application source under `apps/`/`packages/` are modified. Only new
`deploy/` files and this documentation set are added; see the "Files added" list below.

## Topology

```
Internet
   |
   |  HTTPS only (Caddy automatic TLS; :80 -> :443 redirect)
   v
reverse-proxy (Caddy) -- the ONLY publicly reachable service
   |
   |  private Docker network (tna-pilot-internal), no other published ports
   v
tna-control-center (BFF)  ---->  tna-client-gateway   (governed mode; own in-process Gate/Sentinel/
   |                                                     Platform/Ledger stack — see the storage map's
   |                                                     "independence" note)
   |------------------------->  tna-platform          (production mode; real Gate/Sentinel/Ledger)
   \------------------------->  tna-improvement-governor
```

`tna-ledger` and `tna-auditor` (the two standalone apps) are **not** part of this topology — see
"Deployment blockers" below and the security checklist for the full finding. Control Center's Evidence
Explorer and Audit pages honestly render a real `503 NOT_CONFIGURED` for the pilot tenant rather than
omitting or faking that surface (verified live — see the verification report).

## What is real in this deployment

Everything. Every container runs the accepted, unmodified application code (`apps/tna-platform`,
`apps/tna-client-gateway`, `apps/tna-improvement-governor`, `apps/tna-control-center`) built from the
same source that produced the accepted Volume 8/9/10/12/13 tags. No mock, stub, or record-only mode is
used anywhere in this topology — `tna-client-gateway`'s `CLIENT_GATEWAY_MODE` is deliberately left unset
so it defaults to `governed`, the only mode its own `config.ts` accepts once `NODE_ENV=production`.

## Deployment blockers (documented, not routed around)

1. **`tna-ledger` and `tna-auditor` cannot be deployed as separately-reachable containers in their
   current accepted form.** Both apps' `main.ts` hardcode `server.listen(port, '127.0.0.1', ...)` with no
   environment override. A container built from either app's unmodified source is reachable from nothing
   outside its own network namespace — not even sibling containers on the same Docker bridge network.
   Fixing this requires a narrow, separately-reviewed change to those two apps' own `main.ts`
   (configurable bind host) — out of scope for this deployment-closure pass, and not invented here as a
   workaround. Impact: Control Center's Evidence Explorer and Audit pages are unavailable for the pilot
   tenant (real `503`, not a fake `200`).

2. **Client Gateway's governed-execution Ledger is independent of Platform's Ledger.**
   `apps/tna-client-gateway/src/governed-execution.ts`'s `buildGovernedIntegration()` constructs its own
   complete Gate/Sentinel/PlatformStore/Ledger stack in-process, writing to
   `tna-client-gateway-ledger.sqlite` — a different file from Platform's `tna-ledger.sqlite`. This is an
   accepted Volume 10 architectural choice (Client Gateway is its own governed-execution surface, not a
   thin proxy to Platform), not a pilot-deployment defect. Practical effect: a governed execution
   initiated through Client Gateway's own API is not visible in Control Center's Platform-backed evidence
   views, and vice versa.

3. **Platform's demo agent token has no `_FILE` secret variant.**
   `apps/tna-platform/src/main.ts` reads `TNA_PLATFORM_DEMO_AGENT_TOKEN` as a literal environment value
   only. Platform's Dockerfile (`deploy/docker/Dockerfile`) is the accepted, frozen Volume 9 image — this
   pilot does not add an entrypoint wrapper to it (unlike the three new images built for this pilot),
   because doing so would mean modifying accepted packaging. The token is supplied as a real literal
   Compose variable (`${TNA_PILOT_PLATFORM_AGENT_TOKEN:?...}`), sourced from an operator's own
   gitignored env file — never a Docker secret file, never typed into version control.

4. **Platform's HTTP API has no route to register a Gate agent or issue an authority envelope.**
   `apps/tna-platform/src/server.ts` exposes no admin endpoint for this — the accepted product only does
   it in-process, directly against Gate's own SQLite file, exactly the way `scripts/demo-platform-v01.ts`
   already does. The pilot runbook's bootstrap step (`deploy/compose/bootstrap-platform-agent.js`) performs
   this once per pilot agent identity by calling Gate's own existing `register`/`setEnvelope` methods
   against the running container's `/data` volume — it adds no new capability and changes no accepted
   code.

5. **Platform's only wired tool connector is hardcoded to tenant id `tenant_demo`.**
   `apps/tna-platform/src/connectors.ts`'s `buildDefaultConnectorRegistry()` registers exactly one
   connector (`DEMO_ECHO_CONNECTOR`), whose `tenant_id` is a literal `'tenant_demo'`
   (`packages/platform-connectors/src/index.ts`), and `ConnectorRegistry.list()` filters strictly on that
   literal. Platform has no multi-tenant connector-onboarding API in v0.1. The pilot therefore runs
   Platform's own `TNA_TENANT_ID` as `tenant_demo` — deliberately decoupled from the Client-Gateway-minted
   tenant id used everywhere else (Platform and Client Gateway are already independent stacks; see
   finding 2) — so one real, tool-executing governed action can be demonstrated using the shipped default.
   This is a config choice, not a code change.

6. **RESOLVED — Improvement Governor previously crashed on any restart against its own persisted data.**
   `apps/tna-improvement-governor/src/main.ts` unconditionally constructs its server
   (`createImprovementGovernorServer`) on every process start, which unconditionally calls
   `registerImprovementGovernor()` (`packages/improvement-core/src/gate-integration.ts`). Before this
   fix, that function called `gate.register()` with no existence check, and `Gate.register()` throws
   `HttpError(409, 'Agent already registered')` once the agent id is already present — which it always is
   after a successful first start against a persistent volume, putting the container into an
   unrecoverable crash loop. This was a genuine, reproduced Volume 12 reliability defect (see
   `pilot-deployment-verification-v0.1.md` for the exact captured exception/stack), not a
   pilot-configuration issue.
   **Remediated under "TNA Volume 12 Post-Acceptance Reliability Remediation"**: `registerImprovementGovernor()`
   now distinguishes the one specific, well-typed "already registered" conflict from every other failure
   (which still propagates and crashes the process exactly as before, preserving fail-closed startup);
   on that restart path it verifies the persisted identity's name/role/owner against the same trusted,
   code-derived values a fresh registration would use — throwing a distinct `GovernorIdentityConflictError`
   and failing closed if they ever diverge — before re-establishing the exact same deterministic envelope
   `governorEnvelope()` always produces. No new identity store, no bypass of Gate's own API, no blanket
   `try { register() } catch {}`. See `packages/improvement-core/src/gate-integration.ts` and
   `tests/improvement/gate-integration-restart.test.ts` (8 new regression tests) for the full fix and its
   proof. Verified live: 3 consecutive `docker restart` cycles against the same persisted Gate/Improvement
   store, zero crash-loop, `RestartCount=0`, a pre-restart generation remained fully reconstructible with
   its real status intact, and a fresh post-restart generation was still real-Gate-ALLOWed.

None of these blockers required inventing a workaround; each is either left honestly unwired (1, 2) or
solved using only the accepted product's own existing public mechanisms (3, 4, 5), and finding 6 is now
resolved with a narrow, tested source fix.

## Files added

- `deploy/compose/compose.pilot.yaml` — the pilot topology (separate from, does not modify,
  `compose.production.yaml`).
- `deploy/docker/Dockerfile.client-gateway`, `Dockerfile.improvement-governor` — new images, same
  multi-stage/non-root/direct-exec conventions as the accepted `deploy/docker/Dockerfile`.
- `deploy/docker/entrypoints/{client-gateway,improvement-governor,control-center}.sh` — secret-file-to-
  env-var wrapper scripts (see the security checklist, item B).
- `deploy/config/Caddyfile.pilot` — the one public entrypoint.
- `deploy/compose/tenant-registry.pilot.example.json` — template only; no real credentials.
- `deploy/compose/bootstrap-platform-agent.js` — one-time Gate agent bootstrap (finding 4 above).
- `deploy/compose/pilot-verify.js` — operator verification script (real HTTP calls against the running
  stack; see the verification report).
- This file and its four companions under `docs/deployment/pilot-*`.
- `deploy/docker/Dockerfile.control-center` gained an entrypoint-wrapper `COPY`/`ENTRYPOINT` (already
  part of the in-progress Volume 13 work, not a change to any accepted/tagged state).

## What was explicitly NOT done

Per the task's own instructions: no redesign of TNA, no new product capabilities, no change to accepted
control semantics, no accepted tag moved, no Kubernetes, no multi-region, no enterprise SSO, no billing,
and Volume 14 was not started.

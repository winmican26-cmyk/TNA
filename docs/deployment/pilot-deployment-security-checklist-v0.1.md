# TNA Pilot Deployment v0.1 — Security Checklist

Every item below marked "verified live" was checked against a real, running local pilot stack (Docker
Compose, all four application containers healthy, Caddy fronting them) — not inferred from reading code.
See `pilot-deployment-verification-v0.1.md` for the literal commands and captured output.

## A. Internet exposure

| Check | Result |
|---|---|
| Only one publicly reachable service | **Verified live** — `docker port` on all five containers shows only `reverse-proxy` (Caddy) with published ports (`80`, `443`); Platform, Client Gateway, Improvement Governor, and Control Center each publish nothing. |
| Platform/Client Gateway/Improvement Governor reachable from the internet | **NO** — no `ports:` mapping in `compose.pilot.yaml` for any of them; reachable only on the internal `tna-pilot-internal` bridge network. |
| Ledger/Auditor reachable at all | **NO, by construction** — not wired into the topology (see item B). |

## B. The Ledger/Auditor blocker

`apps/tna-ledger/src/main.ts` and `apps/tna-auditor/src/main.ts` hardcode
`server.listen(port, '127.0.0.1', ...)`. No environment variable overrides the bind host. A container
built from either app's current source is unreachable from every other container on its own Docker
network, not just from the internet. This was not routed around: neither app has a Dockerfile in this
pilot, and neither is referenced in `compose.pilot.yaml`. **Verified live**: `GET /api/evidence/search`
and `GET /api/audit/assessments` through the real public endpoint both return real `503`s with
`code: "NOT_CONFIGURED"` — the same honest behavior `tests/control-center/evidence-audit.test.ts` already
proves at the unit level. Fixing this is a narrow, separately-reviewed change to those two apps'
`main.ts` — out of scope here.

## C. TLS

| Check | Result |
|---|---|
| HTTP -> HTTPS redirect | **Verified live** — `curl http://localhost/` returns `308` to `https://localhost/`. |
| HTTPS reachable, real response | **Verified live** — `curl -k https://localhost/` returns `200` with `HSTS`, `CSP`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, all from the real Caddy + Control Center response, not asserted from config alone. |
| Real public-DNS ACME certificate | **NOT verified in this environment** — this sandbox has no real public DNS or internet-reachable inbound port. Local testing used Caddy's automatic substitution of its own internal CA for the literal hostname `localhost` (real, accepted Caddy behavior — see the Caddyfile's own comment), which proves the redirect/header/reverse-proxy wiring but proves nothing about real ACME issuance. **An operator must independently confirm real ACME issuance once a real pilot hostname with real DNS is in place** — this is an honest, explicitly flagged gap, not a claimed pass. |

## D. Cookies and sessions

**Verified live** via a real login through the public HTTPS endpoint:
```
Set-Cookie: tna_cc_session=...; Path=/; Max-Age=28800; SameSite=Lax; HttpOnly; Secure
Set-Cookie: tna_cc_csrf=...;    Path=/; Max-Age=28800; SameSite=Lax; Secure
```
Session cookie is `HttpOnly` + `Secure`; CSRF cookie is `Secure` but deliberately not `HttpOnly` (it must
be readable by the frontend to echo back as a header — the standard double-submit pattern), both
`SameSite=Lax`. `TNA_CONTROL_CENTER_COOKIE_SECURE=true` is set unconditionally in `compose.pilot.yaml`.

## E. CSRF

**Verified live** — `POST /api/actions/<id>/approve` with a valid session cookie but no CSRF header
returns a real `403 {"error":"CSRF token missing or invalid"}` through the public endpoint. This is
inherited, unmodified Volume 13 behavior (`requireCsrf()` in `apps/tna-control-center/src/server.ts`) —
the pilot changes no application code, only how it's deployed.

## F. CORS

**Verified live** — `GET /api/session/me` with `Origin: https://evil.example.com` returns no
`Access-Control-Allow-Origin` header at all (checked programmatically in `pilot-verify.js`). Exact-match
origin allowlisting (`applyCors()`, unmodified from Volume 13) is configured via
`TNA_CONTROL_CENTER_TRUSTED_ORIGINS: https://${TNA_PUBLIC_HOSTNAME}` — never a wildcard, never
credentials without a matched origin.

## G. Tenant isolation, roles, XSS, unknown-state, stale-state rendering

**Not independently re-derived for this pilot pass** — these are properties of the Control Center
application code itself (`apps/tna-control-center`, `apps/tna-control-center-web`), which this
deployment-closure pass does not modify. They remain covered by the accepted Volume 13 test suite
(1098/1098 `node:test`, 27/27 Playwright, including `cross-tenant.spec.ts`, `stale-state.spec.ts`, and
`unknown-state.spec.ts`) captured at the `tna-control-center-v0.1` tag. Re-running the full suite was out
of scope for a deployment-topology pass with no source changes to that code; **this checklist does not
claim to have re-verified them live in the pilot container**, only that the pilot ships the identical,
unmodified build that suite already covers.

## H. No secrets in the frontend, logs, or a directly-exposed database

- The compiled frontend (`apps/tna-control-center-web/dist`) never embeds a token — it calls the BFF,
  which holds every credential server-side (unchanged Volume 13 architecture).
- No component's structured log output includes a raw secret — Platform's `/diagnostics` route
  explicitly redacts (`redact()`, unmodified).
- No SQLite file is exposed on any published port; every `/data` volume is reachable only via the owning
  container (confirmed by the same `docker port` output as item A — nothing but Caddy's 80/443 is
  published, and Caddy proxies only to Control Center's application port, never to a raw DB port, because
  no DB process listens on a network port at all — `node:sqlite`/`better-sqlite3` are in-process file
  handles, not network servers).

## I. No dev/demo placeholder credentials in the pilot's real secrets

- `deploy/compose/secrets/*.txt` are freshly generated per deployment (`openssl rand`/`crypto.randomBytes`
  — see the runbook step 1), never a checked-in placeholder.
- `apps/tna-ledger/src/server.ts` and `apps/tna-auditor/src/server.ts`'s own `validateCredentials()`
  (moot here since neither is deployed, but relevant to the general policy) already refuses same-value or
  short (<32 char) credentials — this pilot's own generated tokens satisfy that bar.
- The one unavoidable exception, documented rather than hidden: Platform's demo agent token
  (`TNA_PLATFORM_DEMO_AGENT_TOKEN`) is architecturally a "single static demo credential" by Volume 8
  design (no external customer IAM in v0.1) — the pilot supplies a freshly generated real value for it,
  never the word "demo" or any literal from `scripts/demo-platform-v01.ts`, but the *mechanism* itself
  (one shared static token, not per-request customer identity) is an inherited, documented v0.1 limitation
  — not something this deployment pass could close without modifying accepted Volume 8/9 code.

## J0. Restart resilience (all four components)

**Verified live**: `tna-client-gateway`, `tna-platform`, and `tna-control-center` all restarted cleanly
(`docker restart`) and returned to real `healthy` status with all prior data intact and reachable.
`tna-improvement-governor` originally did **not** — a real, reproduced crash-loop (see the overview's
blocker 6 and item K below). **This has since been fixed** (TNA Volume 12 Post-Acceptance Reliability
Remediation) and re-verified live: 3 consecutive restart cycles against the same persisted volume, all
reaching real `healthy` status, `RestartCount=0` (confirming these were clean restarts, not crash-loop
auto-restarts), a pre-restart generation still reconstructible with its real `AUTHORIZED` status intact,
and a fresh post-restart generation still real-Gate-ALLOWed.

## J. Failure-state honesty (never false-healthy)

**Verified live**: stopping `tna-client-gateway` (`docker stop`) causes `GET /api/dashboard` through the
real public endpoint to return a real `503` with an honest error message
(`"Could not verify tenant status with the authoritative Client Gateway record"`) rather than a stale or
fabricated `200`. Restarting the container and waiting for its own real healthcheck to report `healthy`
restores the real `200` with real component data — no manual Control Center restart or session
re-establishment was needed, proving the failure and recovery are both genuine, not session-cached.

## K. Volume 12 (Recursive Improvement Governance) preservation re-check and remediation

Real restart testing during the initial pilot-closure pass surfaced a genuine pre-existing reliability
defect in the already-accepted Volume 12 code, invisible from a code read alone: `docker restart` against
a data volume that already had the governor's agent registered crashed the process permanently (exact
exception/stack captured in the verification report). This was not present in, or missed by, Volume 12's
own accepted test suite because that suite never exercised a real process restart against
already-populated persistent storage — a gap in test coverage, not a false claim in the original
acceptance.

**This has been remediated** under a narrowly-scoped follow-up ("TNA Volume 12 Post-Acceptance
Reliability Remediation"). Scope of the change:
- **Source touched**: only `packages/improvement-core/src/gate-integration.ts` (the compiled
  `dist/.../gate-integration.js` is generated, never hand-patched).
- **No accepted authority, evaluator, promotion, rollback, canary, Ledger, Sentinel, or VAD semantics
  were altered.** `registerImprovementGovernor()`'s observable behavior on a genuinely fresh agent id is
  byte-for-byte unchanged; the only new behavior is what happens on the specific, well-typed "agent
  already registered" conflict, which previously always crashed the process.
- **No accepted tag was moved.**
- 8 new regression tests (`tests/improvement/gate-integration-restart.test.ts`) plus the original 5
  `tests/improvement/gate-integration.test.ts` tests all pass; the full Volume 12 suite (148 tests), the
  recursive-improvement demo, and the recursive-improvement smoke test all pass unchanged; two full
  `npm run check` runs back-to-back (no cleanup between) both pass at 1113/1113.
- **Container-level proof**: 3 consecutive `docker restart` cycles of the real, rebuilt
  `tna-improvement-governor` pilot image against the same persisted `/data` volume, each reaching real
  `healthy` status, `RestartCount=0` throughout (confirming no crash-loop auto-restart occurred), a
  generation authorized before the cycles remained fully reconstructible via the real HTTP API with its
  real `AUTHORIZED` status intact, and a fresh generation created after the cycles was still real-Gate-
  ALLOWed — proving the reconciled envelope keeps functioning identically after restart.

See `packages/improvement-core/src/gate-integration.ts` for the fix itself and
`tests/improvement/gate-integration-restart.test.ts` for the full regression proof, including a dedicated
fail-closed test: a persisted identity under the governor's agent id whose name/role/owner do not match
the expected trusted shape is refused with a distinct `GovernorIdentityConflictError` rather than silently
reconciled.

## L0. Reclassification of the five remaining findings

Each of the five pre-existing findings from the initial pilot-closure pass is reclassified below as
**BLOCKER**, **PILOT LIMITATION**, or **POST-PILOT HARDENING**, answering: does it prevent one controlled
single-tenant external pilot; does it create fabricated evidence; does it create unsafe internet exposure;
does it prevent customer onboarding; does it create a second truth; can it be safely documented as a v0.1
limitation.

**Finding 1 — standalone Ledger/Auditor 127.0.0.1 bind, unavailable in pilot.**
Prevents the pilot? No — Control Center honestly renders `503 NOT_CONFIGURED` for Evidence Explorer/Audit,
never a fake result. Fabricated evidence? No — the surface is absent, not faked. Unsafe exposure? No —
the opposite; it's *more* conservative than intended (unreachable even internally). Blocks onboarding? No.
Second truth? No. **Classification: PILOT LIMITATION.**

**Finding 2 — Client Gateway vs Platform Ledger non-unification.**
Prevents the pilot? No. Fabricated evidence? No — each surface shows its own real evidence; there is no
place where the two are merged and therefore no place where a merge could misrepresent one as the other.
Unsafe exposure? No. Blocks onboarding? No. Second truth? Arguably a *documented* one: two real, honest,
non-overlapping evidence surfaces, never presented as unified. This is an accepted Volume 10 architectural
choice, not a bug. **Classification: PILOT LIMITATION** (candidate for POST-PILOT HARDENING if a future
pilot needs a single unified evidence view across both surfaces).

**Finding 3 — Platform demo-agent token lacks `_FILE` support.**
Prevents the pilot? No — a real, freshly generated secret is supplied via a Compose variable instead of a
Docker secret file; it is never committed, never a placeholder. Fabricated evidence? No. Unsafe exposure?
No — it's a delivery-mechanism difference, not a weaker credential. Blocks onboarding? No — this is a
single shared agent credential model inherited from Volume 8 (no external customer IAM in v0.1), not
specific to this token's delivery mechanism. **Classification: PILOT LIMITATION** (POST-PILOT HARDENING
candidate: add a real `_FILE` variant to `apps/tna-platform/src/main.ts`, a narrow, separately-reviewed
Volume 9 change).

**Finding 4 — Platform has no HTTP agent-registration route.**
Prevents the pilot? No — the provided `bootstrap-platform-agent.js` script performs the one-time step
using Gate's own existing public API, exercised live and proven safe across repeated restarts (see item K).
Fabricated evidence? No — it registers a real Gate agent through real Gate code. Unsafe exposure? No — the
script requires container exec access, the same trust boundary an operator already has. Blocks onboarding?
Only in the sense that onboarding a NEW agent identity is a manual, exec-based step rather than a
self-service HTTP call — a real operational limitation, not a security gap. **Classification: PILOT
LIMITATION** (POST-PILOT HARDENING candidate: a real admin HTTP route for agent registration).

**Finding 5 — Platform's default connector hardcoded to `tenant_demo` — scrutinized specifically, with a
live test.** The concern raised: is this acceptable only for one intentional, explicit demo tenant, or
does it risk a real design partner's requests silently executing under the wrong tenant identity? **Live
test performed**: Platform was run with `TNA_TENANT_ID=tenant_demo` (its actual pilot configuration), and
a real request was submitted with a *different* tenant id in its body
(`tenant_id: "ten_totally_different_design_partner_tenant"`) using a real, valid agent bearer token. Result:
```
$ POST /v1/platform/actions {"tenant_id":"ten_totally_different_design_partner_tenant", ...}
404 {"error":"No platform action pa_14166d13-..."}
```
Root cause, traced through the real code: `PlatformGateOrchestrator.authorize()` looks up the just-created
action row by `principal.tenantId` (always Platform's own single configured tenant — `principalFor()` in
`apps/tna-platform/src/writers.ts` never derives a principal's tenant from the request body, only from
config), while `PlatformStore.createOrReturn()` had stored the row under the body's own `tenant_id`. The
mismatch means the row is never found under the principal's tenant scope — a real, visible `404`, not a
silent success, not execution proceeding under a swapped identity, and no fabricated evidence of any kind.
The orphaned row itself is permanently unreachable through the API (no principal on this Platform process
can ever have a `tenantId` other than the one fixed value), so there is no leak, only inert dead data.
**This confirms there is no "second truth" risk and no silent cross-tenant execution risk in either
misconfiguration direction.** What finding 5 DOES mean: Platform v0.1 is single-tenant-per-process for its
own tool-execution surface, and its only shipped connector only works for the literal tenant id
`tenant_demo`. Prevents the pilot? No, when (as configured and documented here) the pilot deliberately runs
Platform under the single, explicit `tenant_demo` identity for its tool-execution surface, decoupled from
but not conflicting with the real tenant identity used everywhere else (Client Gateway, Control Center).
Blocks onboarding? **Yes, specifically**: a second real design-partner tenant needing its OWN identity
threaded through Platform's tool-execution surface (not just its BFF/session identity) cannot be onboarded
without either (a) accepting the shared `tenant_demo` execution identity model documented here, which
fails closed and never misroutes, or (b) a narrow, separately-reviewed new connector registered for that
real tenant id in `apps/tna-platform/src/connectors.ts`. **Classification: PILOT LIMITATION for the single,
explicit demo/pilot tenant this deployment is configured for; would become a BLOCKER if a future pilot
requires a second real tenant's own identity on Platform's tool-execution surface without that follow-up
connector work.**

## L. Hardcoded-authoritative-evidence guarantee (inherited from Volume 12/13)

Unaffected. This pilot pass adds no new UI code and no new authoritative-evidence path; every number
rendered by Control Center in this deployment still comes from a real backend call, as already audited
and tagged at `tna-control-center-v0.1`.

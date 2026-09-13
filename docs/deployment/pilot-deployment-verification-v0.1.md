# TNA Pilot Deployment v0.1 — Verification Report

Every result below was captured from one real, local Docker Compose run of `compose.pilot.yaml`
(all four application containers plus Caddy) on 2026-09-13, using `TNA_PUBLIC_HOSTNAME=localhost` as the
explicitly-flagged local substitute for a real pilot hostname (see the security checklist item C for what
this does and does not prove). No mock, no interception, no fabricated output.

## 1. Container build and health

All four Dockerfiles (`Dockerfile`, `Dockerfile.client-gateway`, `Dockerfile.improvement-governor`,
`Dockerfile.control-center`) built successfully from the repository root. All four application containers
and Caddy reported real, container-native `healthy` status:
```
tna-pilot-tna-client-gateway-1         Up (healthy)
tna-pilot-tna-control-center-1         Up (healthy)
tna-pilot-tna-improvement-governor-1   Up (healthy)
tna-pilot-tna-platform-1               Up (healthy)
```

## 2. Internet-exposure surface (`docker port`, every container)

```
tna-platform:              (nothing)
tna-client-gateway:        (nothing)
tna-improvement-governor:  (nothing)
tna-control-center:        (nothing)
reverse-proxy:             80/tcp -> 0.0.0.0:80, 443/tcp -> 0.0.0.0:443
```
Only Caddy is reachable from the host at all.

## 3. TLS

```
$ curl -o /dev/null -w "%{http_code} -> %{redirect_url}" http://localhost/
308 -> https://localhost/
$ curl -k -o /dev/null -w "%{http_code}" https://localhost/
200
```

## 4. Response headers (real, via Caddy + Control Center)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self';
  connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

## 5. Real login through the public endpoint

```
$ curl -k -D - -X POST -H "Content-Type: application/json" \
    -d '{"username":"pilot-admin","password":"..."}' https://localhost/api/session/login
HTTP/1.1 200 OK
Set-Cookie: tna_cc_session=...; Path=/; Max-Age=28800; SameSite=Lax; HttpOnly; Secure
Set-Cookie: tna_cc_csrf=...;    Path=/; Max-Age=28800; SameSite=Lax; Secure
```

## 6. Hostile-origin CORS

```
$ curl -k -D - -H "Origin: https://evil.example.com" https://localhost/api/session/me
HTTP/1.1 401 Unauthorized
(no Access-Control-Allow-Origin header present)
```

## 7. CSRF enforcement

```
$ curl -k -X POST -H "Cookie: tna_cc_session=..." -H "Content-Type: application/json" -d '{}' \
    https://localhost/api/actions/nonexistent/approve
{"error":"CSRF token missing or invalid"}   status 403
```

## 8. Evidence Explorer / Audit honest unavailability (Ledger/Auditor blocker)

```
$ curl -k -H "Cookie: ..." https://localhost/api/evidence/search
{"error":"Ledger integration is not configured for this tenant","code":"NOT_CONFIGURED"}   status 503
$ curl -k -H "Cookie: ..." https://localhost/api/audit/assessments
{"error":"Auditor integration is not configured for this tenant","code":"NOT_CONFIGURED"}   status 503
```

## 9. Real end-to-end governed action

Bootstrap and request sequence (see the runbook, steps 6 and 8) produced:
```json
{
  "state": "COMPLETED",
  "gate_decision": { "decision": "ALLOW", "reason": "Action permitted by envelope" },
  "capability_id": "9811c3a4-6221-4d65-b39c-42acfe7ec099",
  "sentinel_session_id": "d9f857ae-0b3f-4264-80d2-bbaafd67ed81",
  "execution": { "result_hash": "bd9516de23f891f9411755b0cfec1c120e55dce8c59cc50852269e1e6040f526" }
}
```
Reconstructed evidence (`GET /v1/platform/actions/<id>/evidence`) showed a complete, real causal chain —
`PLATFORM_ACTION_RECEIVED -> PLATFORM_ACTION_STATE_CHANGED -> PLATFORM_ACTION_AUTHORIZED ->
PLATFORM_EXECUTION_CLAIMED -> PLATFORM_ACTION_COMPLETED` — with `outbox_records: 5, delivered: 5,
dead_lettered: 0`.

Two intermediate real findings surfaced and are documented in the overview/checklist rather than hidden:
an earlier attempt with the Client-Gateway-minted tenant id returned an honest `400 Tool is unregistered
or incompatible` (Platform's default connector is hardcoded to tenant `tenant_demo` — overview finding 5);
an earlier attempt before the Gate-agent bootstrap step returned an honest `401 Invalid credential`, then
after the token-wiring fix a real Gate `BLOCK` (`"Undeclared resource or operation"`) until the envelope's
declared resource pattern was corrected. Each was a real evaluation by real code, not a scripted success.

## 10. Real dashboard, real component health

```
$ curl -k -H "Cookie: ..." https://localhost/api/dashboard
{"assurance":{"ready":true,"status":"AVAILABLE","components":[
  {"component":"platform_store","status":"AVAILABLE","mandatory":true},
  {"component":"gate","status":"AVAILABLE","mandatory":true},
  {"component":"sentinel","status":"AVAILABLE","mandatory":true},
  {"component":"ledger","status":"AVAILABLE","mandatory":true},
  {"component":"auditor","status":"AVAILABLE","mandatory":false}
]},"actions_last_24h":3,"blocked":1,...}
```
(`ledger`/`auditor` here are Platform's own in-process instances, not the undeployed standalone apps.)

## 11. Failure-state honesty

```
$ docker stop tna-pilot-tna-client-gateway-1
$ curl -k -H "Cookie: ..." https://localhost/api/dashboard
{"error":"Could not verify tenant status with the authoritative Client Gateway record"}   status 503
$ docker start tna-pilot-tna-client-gateway-1   # wait for real healthcheck to pass
$ curl -k -H "Cookie: ..." https://localhost/api/dashboard
... status 200, real data, same session cookie, no re-login needed ...
```

## 12. Storage

```
$ docker exec tna-pilot-tna-platform-1 ls -la /data
tna-platform.sqlite  tna-ledger.sqlite  tna-platform-gate.sqlite  tna-platform-sentinel.sqlite
tna-platform-auditor.sqlite  RUNNING.lock  deployment-identity.json  (+ -wal/-shm side files)
```
(Full listing for all four components is in `pilot-deployment-storage-map-v0.1.md`.)

## 13. Automated verification script

`deploy/compose/pilot-verify.js`, run end-to-end with real, operator-created credentials
(`TNA_PILOT_ADMIN_USER`/`TNA_PILOT_ADMIN_PASSWORD` — never a hardcoded value in the script), reproduced
items 5-8 in one pass with a clean exit.

## 14. Restart resilience — one critical finding, since fixed and re-verified

`tna-client-gateway`, `tna-platform`, and `tna-control-center` were each restarted (`docker restart`)
against their real, already-populated data volumes and returned to real `healthy` status with prior data
intact (confirmed by re-running the dashboard/login checks afterward).

`tna-improvement-governor` originally did not survive a restart:
```
$ docker restart tna-pilot-tna-improvement-governor-1
$ docker logs tna-pilot-tna-improvement-governor-1
HttpError: Agent already registered
    at Gate.register (file:///app/dist/apps/tna-gate-api/src/gate.js:46:27)
    at registerImprovementGovernor (file:///app/dist/packages/improvement-core/src/gate-integration.js:64:10)
    at createImprovementGovernorServer (file:///app/dist/apps/tna-improvement-governor/src/server.js:110:5)
    at file:///app/dist/apps/tna-improvement-governor/src/main.js:32:16
$ docker inspect tna-pilot-tna-improvement-governor-1 --format '{{.RestartCount}} {{.State.Status}} {{.State.ExitCode}}'
5 exited 1
```
Standalone reproduction (outside the container, same real code path) captured the identical exception:
```
Error: Agent already registered
    at file:///.../dist/apps/tna-gate-api/src/gate.js:48:23
    at Store.transaction (file:///.../dist/packages/evidence-core/src/index.js:47:27)
    at Gate.register (file:///.../dist/apps/tna-gate-api/src/gate.js:46:27)
    at registerImprovementGovernor (file:///.../dist/packages/improvement-core/src/gate-integration.js:64:10)
```

### Fix and re-verification (TNA Volume 12 Post-Acceptance Reliability Remediation)

`registerImprovementGovernor()` (`packages/improvement-core/src/gate-integration.ts`) was changed to
distinguish the specific "Agent already registered" 409 from every other failure, verify the persisted
identity's name/role/owner against the trusted, code-derived expected shape on that path (failing closed
with a new `GovernorIdentityConflictError` if they diverge), and otherwise re-establish the exact same
deterministic envelope. Unit-level proof: `tests/improvement/gate-integration-restart.test.ts`, 8/8
passing —
```
✔ fresh startup: registers the governor and installs the expected envelope
✔ clean restart with the same persisted Gate store does not throw
✔ second restart also does not throw
✔ an existing, expected governor identity is never re-registered as a duplicate
✔ approval boundaries are unchanged after a restart: the governor still cannot self-approve its own promotion
✔ authority ceiling is unchanged after a restart: a write outside the declared envelope scope is still BLOCKed
✔ a persisted identity that does not match the expected trusted governor shape fails closed
✔ a generation created before a restart remains reconstructible/usable after it
```
Full Volume 12 suite: 148/148 passing (unchanged). Demo (`demo:recursive-improvement:v01`) and smoke
(`smoke:recursive-improvement:v01`) both passed unchanged. Two consecutive `npm run check` runs, no
cleanup between: both `1113/1113` passing.

Container-level re-verification, rebuilt pilot image, same live topology:
```
$ docker exec tna-pilot-tna-improvement-governor-1 ... POST /v1/improvements   # create gen_85ecdace...
$ docker exec tna-pilot-tna-improvement-governor-1 ... POST /v1/improvements/gen_85ecdace.../authorize
  -> 200 {"decision":{"decision":"ALLOW", ...}}   (real Gate ALLOW, pre-restart)

$ for i in 1 2 3; do docker restart tna-pilot-tna-improvement-governor-1; wait-for-healthy; done
  restart 1: healthy (4 health-check attempts)
  restart 2: healthy (4 health-check attempts)
  restart 3: healthy (4 health-check attempts)
$ docker inspect ... --format '{{.RestartCount}} {{.State.Status}}'
  0 running          # confirms these were clean restarts, not on-failure crash-loop restarts

$ GET /v1/improvements/gen_85ecdace.../lineage         -> 200, node still present, finalState UNKNOWN (real, not fabricated)
$ POST /v1/improvements/gen_85ecdace.../authorize      -> 409 "Illegal transition AUTHORIZED -> AUTHORIZED"
  (a REAL, correct state-machine guard — proves the generation's real AUTHORIZED status survived 3 restarts
  intact, rather than being reset or corrupted)
$ POST /v1/improvements (new gen_2548ad43...) -> 201
$ POST /v1/improvements/gen_2548ad43.../authorize -> 200 {"decision":{"decision":"ALLOW", ...}}
  (a fresh generation, post-3-restarts, still real-Gate-ALLOWed — proves the reconciled envelope keeps
  functioning identically, not merely "does not crash")
```
Control Center, through the real public HTTPS endpoint, against the post-restart governor:
```
$ GET /api/improvements?systemId=sys_c5d69b7e...   -> 200, both generations, real AUTHORIZED status
$ GET /api/improvements/gen_85ecdace.../lineage    -> 200, real lineage graph
```
No workaround was used to reach this state — no data was wiped on the real verification container, no
error was swallowed generically, and the fail-closed conflict path was separately proven with a dedicated
unit test using a genuinely divergent persisted identity.

## Not verified in this pass

- Real public ACME certificate issuance (needs a real hostname + real DNS + real internet-reachable
  inbound; see security checklist item C).
- Application-level tenant isolation, XSS, unknown/stale-state rendering — inherited from the unmodified
  Volume 13 test suite, not re-derived here (security checklist item G).

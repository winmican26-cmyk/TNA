# TNA Pilot Deployment v0.1 — Operator Runbook

Every step below was executed against a real, running local Docker stack while writing this document
(see `pilot-deployment-verification-v0.1.md` for the captured results) — this is not a theoretical
procedure.

## Prerequisites

- A dedicated pilot hostname with DNS already pointing at this host (**never `localhost`** for a real
  external pilot — see item 3). Local rehearsal of this runbook may use `localhost`; Caddy automatically
  substitutes its own internal CA for that name instead of attempting real ACME (see the Caddyfile's own
  header comment) — this is a real, accepted Caddy behavior, not a workaround, but it is not proof the
  real hostname's ACME path works, which must be checked separately once real DNS exists.
- Docker Engine + Compose v2 on a portable Linux host (see the deployment-target discussion below).
- Seven real, freshly generated secret values (never reused from any other environment):
  `operator_token`, `admin_token`, `service_token`, `capability_key`, `client_gateway_admin_token`,
  `improvement_admin_token`, plus one literal env var for the Platform demo agent token (see step 4).

## 1. Generate real secrets

```
mkdir -p deploy/compose/secrets
for f in operator_token admin_token service_token capability_key client_gateway_admin_token improvement_admin_token; do
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "deploy/compose/secrets/$f.txt"
done
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > deploy/compose/secrets/platform_demo_agent_token.txt
```
None of these files are ever committed (`deploy/compose/secrets/` is gitignored).

## 2. Set the required environment variables

Create a gitignored env file (matching `deploy/compose/*.pilot.env`), e.g. `operator.pilot.env`:
```
TNA_PUBLIC_HOSTNAME=pilot.your-real-domain.example
TNA_PILOT_PLATFORM_AGENT_TOKEN=<contents of secrets/platform_demo_agent_token.txt>
```
`TNA_PILOT_TENANT_ID` is set in step 3, after Client Gateway mints it — it cannot be chosen in advance.

## 3. Start Client Gateway alone and mint the real pilot tenant

`ClientStore.createTenant()` (`apps/tna-client-gateway/src/store.ts`) always mints its own `ten_<uuid>` —
it cannot accept a caller-chosen tenant id. Discovered by testing, not documentation: attempting to
pre-choose a tenant id and use it elsewhere before Client Gateway has created it returns a real `503`
everywhere else, because that id is genuinely not registered yet.

```
docker compose --env-file operator.pilot.env -f deploy/compose/compose.pilot.yaml up -d --build tna-client-gateway
# wait for it to report healthy, then:
docker exec tna-pilot-tna-client-gateway-1 node -e "
  fetch('http://127.0.0.1:4318/v1/admin/tenants', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TNA_CLIENT_ADMIN_TOKEN },
    body: JSON.stringify({ display_name: 'Pilot Tenant' })
  }).then(r => r.json()).then(t => console.log(JSON.stringify(t)))"
# capture the real minted tenant_id from the response, then activate it:
docker exec tna-pilot-tna-client-gateway-1 node -e "
  fetch('http://127.0.0.1:4318/v1/admin/tenants/<REAL_TENANT_ID>/activate', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.TNA_CLIENT_ADMIN_TOKEN }
  }).then(r => r.json()).then(t => console.log(JSON.stringify(t)))"
```
Append `TNA_PILOT_TENANT_ID=<REAL_TENANT_ID>` to `operator.pilot.env`.

## 4. Build the tenant registry from the real minted id

Copy `deploy/compose/tenant-registry.pilot.example.json` to `deploy/compose/tenant-registry.pilot.json`
(gitignored) and fill in: `tenant_id` = the real id from step 3; `platform_token` = the same value as
`TNA_PILOT_PLATFORM_AGENT_TOKEN`; `platform_operator_token` = `secrets/operator_token.txt`'s contents;
`improvement_admin_token` = `secrets/improvement_admin_token.txt`'s contents.

## 5. Start the remaining services

```
docker compose --env-file operator.pilot.env -f deploy/compose/compose.pilot.yaml up -d --build
```
Wait for `tna-platform`, `tna-improvement-governor`, and `tna-control-center` to all report `healthy`
(`docker compose --env-file operator.pilot.env -f deploy/compose/compose.pilot.yaml ps`).

## 6. Bootstrap one Gate agent identity for Platform (real governed-action demo)

Platform's HTTP API has no route to register a Gate agent or set its authority envelope — the accepted
product only does this in-process, the same way `scripts/demo-platform-v01.ts` already does. Run the
provided bootstrap script once per agent identity, via stdin (Platform's container filesystem is
`read_only: true`, so `docker cp` into it fails by design — piping to `node --input-type=module -` needs
no filesystem write):
```
cat deploy/compose/bootstrap-platform-agent.js | docker exec -i tna-pilot-tna-platform-1 node --input-type=module - pilot-agent-1 "Pilot Agent"
```
This registers `pilot-agent-1` in Platform's own Gate store and issues it an envelope scoped to the
shipped `demo.echo` tool (see the overview's blocker 5 for why Platform's own tenant is `tenant_demo`).

## 7. Create the first Control Center operator account

```
docker exec tna-pilot-tna-control-center-1 node dist/scripts/control-center-create-user.js <REAL_TENANT_ID> pilot-admin '<a real, freshly generated password>' client-admin
```

## 8. Run a real governed test action

```
docker exec tna-pilot-tna-platform-1 node -e "
  fetch('http://127.0.0.1:4618/v1/platform/actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TNA_PLATFORM_DEMO_AGENT_TOKEN },
    body: JSON.stringify({ version: '1.0', request_id: 'req_bootstrap_' + Date.now(), tenant_id: 'tenant_demo',
      agent_id: 'pilot-agent-1', action: 'demo.echo.execute', tool: 'demo.echo', operation: 'read',
      resource: '/pilot/verification/demo', input: {}, requires_verification: false })
  }).then(r => r.json()).then(a => console.log(JSON.stringify(a)))"
```
Expect `state: \"COMPLETED\"` with a real `gate_decision.decision: \"ALLOW\"`, `capability_id`,
`sentinel_session_id`, and `result_hash` — exactly what was captured live (see the verification report).

## 9. Log in through the real public endpoint and confirm the dashboard

```
curl -D - -X POST -H "Content-Type: application/json" \
  -d '{"username":"pilot-admin","password":"<the password from step 7>"}' \
  https://<TNA_PUBLIC_HOSTNAME>/api/session/login
```
Confirm the `Set-Cookie` response carries `Secure; HttpOnly` on the session cookie and `Secure` on the
CSRF cookie, then use the returned cookies against `/api/dashboard` and confirm real component health.

## 10. Run the full automated verification script

```
TNA_PILOT_ADMIN_USER=pilot-admin TNA_PILOT_ADMIN_PASSWORD='<password>' \
  node deploy/compose/pilot-verify.js https://<TNA_PUBLIC_HOSTNAME>
```
See `pilot-deployment-verification-v0.1.md` for what a clean run looks like and what every line proves.

## Deployment target

A single portable Linux Docker host (Compose v2). No cloud-vendor-specific service, no Kubernetes, no
multi-region topology — none of this is invented for the pilot and none of it is required to run the
compose file as written. Required inbound firewall rules: TCP 80 and 443 to the host, from the internet,
routed only to the `reverse-proxy` container (the only container with published ports — verified live,
see the verification report's `docker port` output). No other inbound port is required or should be
opened.

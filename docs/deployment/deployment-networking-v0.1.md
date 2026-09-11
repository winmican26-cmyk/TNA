# TNA Deployment Engineering v0.1 — Networking

## Network exposure (section 24-25)

Production topology (`compose.production.yaml`) publishes exactly two host ports: `80`/`443` on the
reverse proxy (Caddy). `tna-platform` itself has **no** `ports:` mapping at all — it is reachable only
from Caddy, over the internal Docker network. No SQLite file is ever exposed over any network share or
port (section 25) — every store is a local file under `/data`, opened only by the owning in-process
class; this is explicitly a single-host deployment assumption (see "Remaining limitations" in
`deployment-overview-v0.1.md`'s companion threat model).

## TLS / reverse proxy (section 26-27)

TLS terminates at Caddy (`deploy/config/Caddyfile`), using Caddy's automatic HTTPS for
`$TNA_PUBLIC_HOSTNAME`. `tna-platform` itself speaks plain HTTP only, and only to Caddy. The development
compose file (`compose.yaml`) deliberately has no TLS and publishes the platform's port directly — it is
visually and functionally distinguished from `compose.production.yaml` by its filename, its top-level
comment, and its lack of any `reverse-proxy` service, so it cannot be mistaken for a production
configuration.

One supported reverse proxy (Caddy) is documented and shipped — not five. The Caddyfile sets, explicitly
rather than by relying on defaults:

- `request_body { max_size 2MB }` — a proxy-level bound at least as strict as the application's own
  `TNA_MAX_BODY_BYTES` (256KiB default), so the proxy never lets through an order-of-magnitude larger
  request than the application itself would accept (section 69).
- `dial_timeout`, `response_header_timeout`, `read_timeout` on the upstream transport (section 68).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` (section 67) — no
  `Content-Security-Policy` is set, since there is no browser frontend behind this proxy to scope one for
  (section 67: "Do not cargo-cult browser headers where not relevant").
- `header_up X-Forwarded-For {remote_host}` / `X-Forwarded-Proto {scheme}` forwarded explicitly.

## Trusted proxy model (section 28)

`network.trust_proxy` is a config-level boolean (default `false`). It exists so the *topology* can
declare "a trusted reverse proxy is the only peer that can reach this process," matching the
Caddy-fronted production compose setup where Caddy is genuinely the sole network peer. v0.1 does not yet
consume `X-Forwarded-For`/`X-Forwarded-Proto` for any authorization or rate-limiting decision inside
`apps/tna-platform` itself — so spoofing those headers currently has no security effect either way,
because nothing reads them for a security-relevant purpose yet. This is stated plainly, not left implicit:
seeing `trust_proxy: true` in a diagnostics dump should not be read as "IP-based access control is
enforced here" — it isn't, yet. See `deployment-threat-model-v0.1.md` category "trusted-proxy header
spoofing."

## CORS (section 29)

`network.cors_allow_origin` defaults to `null` — no `Access-Control-Allow-Origin` header emitted at all,
the most restrictive posture for an API with no browser frontend. Setting it to `"*"` is structurally
rejected by `DeploymentConfig`'s production validation (`INSECURE_PRODUCTION_DEFAULT`) — proven directly
in `deployment-config.test.ts`.

## Rate limiting / DoS (section 70-71)

v0.1 provides bounded request size, header size, and timeout enforcement at both the application
(`packages/platform-schema`'s `MAX_BODY_BYTES` etc., unchanged from Volume 8) and proxy layers (above).
No dedicated rate-limiter (token bucket, sliding window, etc.) is implemented in this milestone — there
is currently no public unauthenticated write surface to protect beyond the bearer-auth boundary itself
(every mutating route already requires a credential). **No claim of DDoS resistance is made.** v0.1
provides application- and proxy-level resource bounds, not internet-scale denial-of-service mitigation
(section 71) — that remains explicitly out of scope, consistent with "no service mesh / no managed cloud
infrastructure" (section 3).

## Startup order (section 30)

`compose.production.yaml`'s `reverse-proxy` service declares `depends_on: tna-platform: condition:
service_healthy`, using the platform's own `healthcheck` (`GET /live`) — Compose waits for real
liveness, not merely "the container process started," before starting Caddy. `deployment-container.test.ts`
proves the underlying health endpoint genuinely reflects process state, not a hardcoded 200.

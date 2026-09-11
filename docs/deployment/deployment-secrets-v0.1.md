# TNA Deployment Engineering v0.1 — Secret Management

## Secret reference model (section 18-19)

Configuration never carries a literal secret value — only a `SecretRef`: `{ source: 'env' | 'file', ref:
string }`. `resolveSecretRef()` reads the actual value only at the point of use, in memory, never logged
and never included in a config hash or diagnostics payload.

v0.1 supports exactly the two sources section 18 requires:

- **`env`** — `ref` names an environment variable; its value (must be non-empty) is the secret.
- **`file`** — `ref` names a filesystem path; its trimmed contents (must be non-empty) are the secret.
  This is how `compose.production.yaml` supplies Docker secrets (mounted at `/run/secrets/<name>`).

No external secret-provider abstraction (cloud KMS, Vault, etc.) is built — out of scope for v0.1
(section 18: "Do not integrate a cloud KMS yet unless trivial"). The `SecretRef` shape is deliberately
extensible (`source` is a closed union today, not a generic plugin point) so a future milestone can add a
third source without changing any existing deployment's configuration.

## Environment variables

| Variable | Purpose |
|---|---|
| `TNA_ENV` | `development` \| `test` \| `production` — required |
| `TNA_TENANT_ID` | tenant identifier |
| `TNA_HOST` / `TNA_PORT` | listen address |
| `TNA_TRUST_PROXY` | `true` only directly behind a trusted reverse proxy |
| `TNA_CORS_ALLOW_ORIGIN` | omit for no CORS header (default); never `*` in production |
| `TNA_DATA_DIR` | durable storage root |
| `TNA_REQUEST_TIMEOUT_MS` / `TNA_HEADERS_TIMEOUT_MS` / `TNA_MAX_BODY_BYTES` | resource limits |
| `TNA_OPERATOR_TOKEN` / `TNA_ADMIN_TOKEN` / `TNA_SERVICE_TOKEN` | bearer credentials (env form) |
| `TNA_OPERATOR_TOKEN_FILE` / `TNA_ADMIN_TOKEN_FILE` / `TNA_SERVICE_TOKEN_FILE` | bearer credentials (file form — preferred in production) |
| `TNA_CAPABILITY_KEY` / `TNA_CAPABILITY_KEY_FILE` | capability signing key — required in production |
| `TNA_PLATFORM_DEMO_AGENT_TOKEN` / `TNA_PLATFORM_DEMO_AGENT_ID` | see "Agent identity" below |

Full reference with inline documentation: `deploy/config/.env.example`. It is never populated with real
values — every secret field is explicitly marked and left blank.

## Weak/default secret rejection (section 95)

In production, `resolveDeploymentSecrets()` rejects any resolved value that is a known-weak default
(`changeme`, `admin`, `secret`, `password`, `test-secret`, ...), shorter than 32 characters, or built from
two or fewer distinct characters — and rejects duplicate values across the three tokens. This is a
startup failure, not a warning. See `deployment-config.test.ts` and `deployment-abuse-cases.test.ts`.

## No secret logging (section 20) / no secret in diagnostics dumps (section 21)

- `apps/tna-platform/src/logging.ts`'s `createLogger` redacts every field before writing a line — proven
  directly in `deployment-observability.test.ts` with both a secret-shaped field name and a
  bearer-token-shaped value under an innocuous name.
- There is no `/config` or generic `/debug` route at all (section 21: "Prefer no config-dump route at
  all"). `GET /diagnostics` exists (admin/service credential only) and returns a curated, pre-vetted
  field set (`buildDiagnostics()`) — component versions, config hash, deployment id, bounded outbox
  counts, readiness status — never a raw config object, never a resolved secret value. Proven directly in
  `deployment-health-http.test.ts` by asserting none of the configured credential values appear anywhere
  in the serialized response.

## Service authentication / credential isolation (section 22-23)

Every mutating and read route (apart from `/live`/`/ready`, conventionally unauthenticated status
surfaces) requires a bearer credential mapped to exactly one of `platform-agent` / `platform-operator` /
`platform-admin` / `platform-service` — unchanged from Volume 8's accepted role model. `/diagnostics`,
`/metrics`, and the dead-letter inspection route additionally require admin or service — never agent or
bare operator. There is no single universal credential: the platform's own operator/admin/service tokens
are structurally distinct from Gate's, Sentinel's, Ledger's, and Auditor's own principals (each accepted
component already enforces its own least-privilege principal model internally, unchanged by this
volume) — a compromised Auditor reader identity does not grant Ledger writer privileges, because they are
different principal types entirely, enforced by different accepted packages.

## Agent identity (section 3, 18 — explicit scope boundary)

v0.1 has **no external customer IAM**. `TNA_PLATFORM_DEMO_AGENT_TOKEN`/`_ID` is a single static
credential mapping to one agent identity — the same ergonomics Volume 8's own demo used, now exposed as
deployment configuration rather than hardcoded. A real multi-agent identity provider (OAuth, mTLS,
per-agent credential issuance/rotation) is explicitly out of scope for this milestone (section 3) and is
not invented here. Gate's own agent registration/envelope-setting (`gate.register()`,
`gate.setEnvelope()`) remains a trusted-operator, library-level bootstrap step — there is still no HTTP
route that performs it, matching Volume 8's own accepted boundary exactly.

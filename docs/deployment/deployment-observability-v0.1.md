# TNA Deployment Engineering v0.1 — Observability

## Structured logging (section 57-60)

`apps/tna-platform/src/logging.ts`'s `createLogger(component, sink?)` emits single-line JSON to stdout
(the sink is injectable for tests): `{ timestamp, level, message, component, ...fields }`. Callers pass a
bounded field set — `event`, `tenant_id`, `platform_action_id`, `correlation_id`, `error_code`, etc. — not
every field on every call (section 57: "Do not require every field every time").

**No raw input by default** (section 58): nothing in `main.ts`'s logging calls ever includes a request's
`input`/`metadata` — only identifiers and `error_code`-shaped strings. `PlatformActionRequestInput`'s own
`input_hash` (Volume 8, unchanged) remains the durable, non-reversible record of what was submitted.

**Redaction** (section 59, reused from `deployment-schema`'s `redact()`): every field is deep-scanned;
a secret-shaped field name (`token`, `secret`, `password`, `api_key`, `private_key`, `authorization`,
`credential`, `signing_key`, case-insensitive) or a bearer-token-shaped string value anywhere in the
object tree is replaced with `[REDACTED]` before serialization — proven directly in
`deployment-observability.test.ts` with both shapes of leak attempt.

**Error logging** (section 60): the outbox dispatch failure handler in `main.ts` logs `event:
'OUTBOX_DISPATCH_ERROR'` with the error's `.message` only (never `.stack`, never the raw error object) —
operationally useful without ever risking a secret embedded in a stack trace.

## Metrics (section 61-63)

`packages/deployment-health`'s `MetricsRegistry`/`buildPlatformMetrics()` defines exactly the fixed
section-61 metric set: `actions_received_total`, `actions_blocked_total`, `actions_completed_total`,
`actions_indeterminate_total`, `sentinel_terminations_total`, `outbox_pending`, `outbox_dead_letter`,
`outbox_delivery_failures_total`, `ledger_delivery_latency_ms`, `audits_started_total`,
`audits_failed_total`. Every metric is a plain counter or gauge with **no label at all** — cardinality is
fixed at build time and cannot grow with traffic volume (section 62), proven directly by asserting the
Prometheus text output never contains a `{...}` label set even after 500 simulated increments
(`deployment-observability.test.ts`).

`GET /metrics` (admin/service credential required — section 63: "Do not expose it publicly by default")
renders the registry in Prometheus text-exposition format. It is not published on the public reverse
proxy path by default; a real production deployment restricts network access to it further at the Caddy
layer if external scraping is needed (not built in v0.1 — see `deployment-networking-v0.1.md`).

## Operator diagnostics (section 64)

`GET /diagnostics` (admin/service only) returns component versions, `config_hash`, `deployment_id`, a
bounded outbox-pending count, a dead-letter count, and the current readiness status — via
`buildDiagnostics()`, itself passed through `redact()` as a second, defensive layer. See
`deployment-secrets-v0.1.md` for why this is deliberately narrower than a raw config dump.

## Dead-letter operations (section 65-66)

`GET /v1/platform/outbox/dead-letters` (admin/service only) lists every `DEAD_LETTER` outbox record for
the caller's tenant — read-only. **No "force mark delivered" mutation exists anywhere in this
milestone** (section 65: never fabricate acknowledgement without real Ledger evidence). A manual retry
path is not implemented in v0.1; if built in a future milestone, section 66 requires it preserve the
record's original `event_id` and causal metadata (Volume 8's distributed-evidence closure discipline) —
documented here as a constraint on that future work, not something silently deferred without a trace.

# TNA Operator CLI v0.1 — Diagnostics (`tna doctor`)

## Read-only, by construction

`runDoctor()` (`apps/tna-operator/src/doctor.ts`) calls only `GET /ready` and `GET /diagnostics` on the
platform, and `GET /ready` on the client gateway. There is no code path in this module that issues a
mutating HTTP request — repairing, approving, resetting, rotating, or deleting anything requires a
separate, explicit CLI command (e.g. `hold approve`, `service rotate`), never `doctor` itself.

## Result model

```json
{
  "overall": "PASS | WARN | FAIL | UNKNOWN",
  "checks": [
    { "check_id": "platform.gate", "status": "PASS", "summary": "...", "evidence": { }, "guidance": "..." }
  ]
}
```

`overall` is the worst status among all checks (`FAIL` > `WARN` > `UNKNOWN` > `PASS`).

## Checks performed

| check_id | Source | Meaning |
|---|---|---|
| `platform.<component>` | Platform `/ready` components | One row per readiness component (`platform_store`, `gate`, `sentinel`, `ledger`, `auditor`) |
| `platform.outbox_dead_letter` | Platform `/diagnostics` | FAIL if > 0 — evidence delivery has exhausted retries somewhere |
| `platform.outbox_pending` | Platform `/diagnostics` | WARN if > 50 |
| `platform.version` | Platform `/diagnostics` | Component versions, config hash, deployment id |
| `client_gateway.readiness` | Client gateway `/ready` | FAIL if not ready |
| `client_gateway.governed_execution` | Client gateway `/ready` | WARN if the gateway is running in `record-only` mode (TNA-64) |

## Mandatory vs. optional dependency mapping

A `platform.*` component whose underlying readiness probe marked it `mandatory: true` (platform store,
Gate, Sentinel, Ledger) maps to `FAIL` when unavailable; an optional one (Auditor) maps to `WARN` — the
same mandatory/optional distinction Volume 9's own `/ready` route already established (TNA-52).

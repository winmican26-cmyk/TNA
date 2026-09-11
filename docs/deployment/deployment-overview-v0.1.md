# TNA Deployment Engineering v0.1 — Overview

## Mission

Volume 9 does not add security-product functionality. It makes the accepted TNA platform (`tna-platform-v0.1`)
reproducibly deployable, operable, recoverable, and safely configurable — without weakening any security
boundary accepted in Volumes 1-8 (TNA-43).

The defining question this volume answers: **can a competent operator take a clean machine, provide
approved configuration and secrets, start TNA predictably, observe its health, back it up, restore it,
upgrade it, and stop it — without inventing undocumented procedures or weakening the accepted
architecture?**

## What this volume produces

```
source → build → package → configure → supply secrets → initialize durable state →
start services → verify readiness → observe health → perform backup → restore →
restart → upgrade → rollback → verify integrity
```

Every one of those steps has a real, tested implementation:

| Step | Mechanism |
|---|---|
| build | multi-stage `deploy/docker/Dockerfile`, `npm ci` (lockfile-deterministic) |
| package | one container image, non-root, `dist/apps` + `dist/packages` only |
| configure | `packages/deployment-schema` — strict `DeploymentConfig v1`, fail-closed |
| supply secrets | env value or mounted file (`*_FILE`), never embedded in config |
| initialize | `scripts/tna-init.ts` (`npm run tna:init`) |
| start | `apps/tna-platform/src/main.ts`, `docker compose up` |
| verify readiness | `GET /live`, `GET /ready`, `scripts/tna-verify.ts` |
| observe health | `GET /diagnostics`, `GET /metrics`, structured JSON logs |
| backup | `scripts/tna-backup.ts` (`npm run tna:backup`) — SQLite `VACUUM INTO` + hashed manifest |
| restore | `scripts/tna-restore.ts` (`npm run tna:restore`) — verify-then-restore, never partial |
| restart | real SIGTERM handling, lease/lock-aware recovery |
| upgrade | validated pre-upgrade backup, version-compatibility gate |
| rollback | restore the pre-upgrade backup |
| verify integrity | `verifyLedgerIntegrity()`, reused from the accepted `ledger-integrity` package |

## What this volume is not

No frontend/dashboard, no billing, no customer signup, no marketing site, no multi-region cluster, no
Kubernetes production platform, no managed SaaS control plane, no enterprise SSO, no full external IAM,
no auto-scaling fleet, no service mesh, no cloud-specific managed infrastructure. No commercial/customer
onboarding work was started. This is the deployable-system baseline only.

## Architecture packages

- **`packages/deployment-schema`** — `DeploymentConfig v1`, secret references, strict validation,
  weak-secret detection, redaction. No I/O beyond reading an env var or a secret file.
- **`packages/deployment-health`** — liveness/readiness aggregation, a bounded (label-free) metrics
  registry. No import of any accepted TNA component — callers hand it small probe functions.
- **`packages/deployment-ops`** — deployment identity, component-version compatibility, the running-
  process lock, path-traversal-safe path handling, and SQLite backup/restore/verify (`VACUUM INTO` +
  hashed manifest). A thin wrapper over the accepted `ledger-integrity` package for Ledger verification.
- **`apps/tna-platform`** additions — `config.ts` (strict config loading), `logging.ts` (structured,
  redacted JSON logs), `health.ts` (readiness wiring against real Gate/Sentinel/Ledger/Auditor
  instances), `diagnostics.ts` (safe operator diagnostics, dead-letter inspection, metrics gauges).
  `main.ts` and `server.ts` were extended, not replaced — the accepted Volume 8 HTTP surface and
  orchestration logic are untouched.
- **`deploy/`** — `docker/Dockerfile`, `.dockerignore`, `compose/compose.yaml` (development),
  `compose/compose.production.yaml`, `config/Caddyfile`, `config/.env.example`.

See `deployment-topology-v0.1.md` for the full process/network diagram.

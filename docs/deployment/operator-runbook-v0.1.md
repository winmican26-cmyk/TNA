# TNA Platform — Operator Runbook v0.1

This runbook is written for an operator who did not write the code. Every command below is a real,
tested command against this repository as it exists after the Volume 9 (TNA Deployment Engineering v0.1)
milestone — none of it is aspirational.

## Prerequisites

- Docker and Docker Compose (v2+) installed.
- This repository checked out; you do not need Node.js locally if you only run the container path (the
  `npm run tna:*` commands below are optional convenience wrappers that do require Node 24+ locally).

## 1. Install

```
git clone <this repository>
cd trust-no-agent
```

No build step is required to use the container path — `docker compose ... up --build` builds the image.

## 2. Configure

```
cp deploy/config/.env.example .env
# edit .env: set TNA_ENV=production, TNA_TENANT_ID, and real secret values or *_FILE paths
```

For the production Compose stack, create the secret files it expects instead of plain env values:

```
mkdir -p deploy/compose/secrets
openssl rand -base64 48 > deploy/compose/secrets/operator_token.txt
openssl rand -base64 48 > deploy/compose/secrets/admin_token.txt
openssl rand -base64 48 > deploy/compose/secrets/service_token.txt
openssl rand -base64 48 > deploy/compose/secrets/capability_key.txt
export TNA_PUBLIC_HOSTNAME=your.domain.example
```

**Never commit `deploy/compose/secrets/`.** See `deployment-secrets-v0.1.md` for every supported
variable and `deployment-config-v1.md` for exactly what production startup validates and rejects.

## 3. Initialize

```
npm run tna:init
```

Validates configuration, creates the data directory and every component database's schema, generates a
`deployment_id`, and verifies filesystem permissions. Safe to re-run — it does not overwrite an existing
deployment identity.

## 4. Start

Development (no TLS, port published directly):

```
docker compose -f deploy/compose/compose.yaml up -d --build
```

Production (TLS via Caddy, secrets as files, read-only rootfs):

```
docker compose -f deploy/compose/compose.production.yaml up -d --build
```

## 5. Verify readiness

```
curl -s https://<host>/live
curl -s https://<host>/ready
npm run tna:verify   # deeper, read-only: config + component health + Ledger integrity + version compatibility
```

`tna:verify` exits 0 only when the deployment is READY (AVAILABLE or DEGRADED) and Ledger integrity
passes; non-zero otherwise.

## 6. Submit a smoke action

```
npm run smoke:deployment:v01
```

Boots an isolated instance and drives one governed action through it end to end over real HTTP — use
this to confirm a fresh deployment actually works, not just that the process started.

## 7. View status

```
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/diagnostics
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/metrics
```

`/diagnostics` answers: which version is running, the current config hash, the deployment id, pending/
dead-lettered outbox counts, and overall readiness status — never a secret.

## 8. Backup

```
docker compose -f deploy/compose/compose.production.yaml stop tna-platform
npm run tna:backup
docker compose -f deploy/compose/compose.production.yaml start tna-platform
```

Writes a hashed, manifested snapshot to `<data dir>-backups/<backup_id>/`. **The deployment must be
stopped first** — `tna:backup` refuses outright against a live instance (`BackupQuiesceError`), because
cross-component consistency across five independently-updated component databases requires no writer be
live while they are snapshotted (`VACUUM INTO` alone only proves each individual file is consistent, not
that the set of files is). **Always run this immediately before any upgrade.**

## 9. Restore

```
docker compose -f deploy/compose/compose.production.yaml down   # services must be stopped
npm run tna:restore -- --backup <backup_id> --force
docker compose -f deploy/compose/compose.production.yaml up -d
npm run tna:verify
```

`tna:restore` refuses to run without `--force` (or `TNA_CONFIRM_RESTORE=yes`), refuses a still-live data
directory, refuses an incompatible component-version combination, and refuses to silently mix a backup
from a different deployment unless `--cross-deployment` is also passed.

## 10. Restart

```
docker compose -f deploy/compose/compose.production.yaml restart tna-platform
```

A real SIGTERM is sent; the process finishes/safely abandons in-flight outbox claims (recoverable by
lease expiry), closes its stores, and releases its running lock before exiting. On the next start,
`recoverInterruptedWork()` resolves any action interrupted mid-execution to `INDETERMINATE` — never a
fabricated `COMPLETED`.

## 11. Inspect dead letters

```
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/v1/platform/outbox/dead-letters
```

Read-only. A `DEAD_LETTER` record means Ledger delivery was attempted and exhausted its retry budget —
investigate Ledger connectivity/disk space before assuming evidence is lost (the record itself, and its
original causal metadata, are still present and inspectable).

## 12. Upgrade

```
docker compose -f deploy/compose/compose.production.yaml stop tna-platform   # step 8 — mandatory before upgrading
npm run tna:backup
docker compose -f deploy/compose/compose.production.yaml pull   # or: build the new image tag
docker compose -f deploy/compose/compose.production.yaml up -d
npm run tna:verify
```

If `tna:verify` fails after the upgrade, proceed to Rollback immediately — do not attempt to debug a
production instance that failed its own post-upgrade verification.

## 13. Rollback

```
docker compose -f deploy/compose/compose.production.yaml down
npm run tna:restore -- --backup <pre-upgrade-backup-id> --force
# redeploy the PREVIOUS image tag
docker compose -f deploy/compose/compose.production.yaml up -d
npm run tna:verify
```

There is no in-place schema-downgrade mechanism — restoring the pre-upgrade backup is the only
supported rollback path (`deployment-rollback-v0.1.md`).

## 14. Stop

```
docker compose -f deploy/compose/compose.production.yaml down
```

Sends SIGTERM to the platform container, waits for it to exit cleanly, then stops Caddy.

## 15. Incident first-response

1. `curl -s https://<host>/ready` — is it READY, DEGRADED, or UNAVAILABLE, and which component?
2. `curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/diagnostics` — version, config hash,
   outbox pending/dead-letter counts.
3. `docker compose -f deploy/compose/compose.production.yaml logs tna-platform --since 15m` — structured
   JSON logs, already secret-redacted; safe to paste into a ticket.
4. If data corruption is suspected: `npm run tna:verify` (includes non-mutating Ledger integrity
   verification) before taking any destructive action.
5. If recovery requires it: follow Restore (step 9) with the most recent known-good backup. Never
   attempt a raw file copy of a live `.sqlite` file as an ad hoc "backup" — it is not guaranteed
   consistent against a live WAL-mode writer.
6. Do not restart a production container in a loop chasing a persistent configuration error —
   `restart: on-failure:5` is bounded precisely so a real operator investigates instead.

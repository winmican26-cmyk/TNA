# TNA Deployment Engineering v0.1 — Operations

## Commands (section 76-83)

| Command | Purpose |
|---|---|
| `npm run tna:init` | Validate config, create the data directory + every component database's schema, generate a deployment identity, verify filesystem permissions (POSIX). Never runs implicitly from an API request (section 76). |
| `docker compose -f deploy/compose/compose.yaml up -d --build` (dev) / `... compose.production.yaml ...` (prod) | Start (section 77). |
| `docker compose ... down` / `docker stop <container>` | Stop (section 78) — a real SIGTERM inside the container, handled gracefully by `main.ts`. |
| `curl https://<host>/live`, `curl https://<host>/ready` (admin: `/diagnostics`) | Status (section 79) — "is it up," "is it ready," "which components are degraded," and (via `/diagnostics`) which version/config hash is running. |
| `npm run tna:backup` | Backup (section 80). **Requires the deployment to be stopped** — see "Backup requires a stopped deployment" below (recovery-consistency closure). |
| `npm run tna:restore -- --backup <id> --force` | Restore (section 81) — requires explicit confirmation. |
| `npm run tna:verify` | Verification (section 82) — read-only: config, component health, Ledger integrity, version compatibility. Never mutates production work. |
| `npm run smoke:deployment:v01` | Smoke test (section 83) — one safe, deterministic governed action against a freshly booted instance. |
| `npm run demo:deployment:v01` | Full six-flow deployment demo (section 84-90). |

## Graceful shutdown (section 53-55)

`main.ts` registers `SIGINT`/`SIGTERM` handlers that: stop the outbox-dispatch timer immediately (no new
delivery claims are attempted), stop accepting new HTTP connections, close every store connection, and
release `RUNNING.lock` — then exit 0. An in-flight outbox claim this process already owned is left
exactly as-is: it is either completed before the process exits, or, if not, recovered by lease expiry on
a future dispatch attempt (Volume 8's distributed-evidence closure) — **never stolen preemptively, never
falsely marked delivered** (section 54). Proven with a real `docker stop` sending a genuine SIGTERM to
PID 1 inside a real Linux container (`deployment-container.test.ts`) — the authoritative proof, since
Node's SIGTERM handling is unreliable on native Windows (documented in `deployment-shutdown.test.ts`).

## In-flight execution shutdown (section 55-56)

If a process is killed while an action is genuinely `EXECUTING`, the next `PlatformStore` construction's
`recoverInterruptedWork()` (Volume 8, unchanged) recovers it to `INDETERMINATE` — never a fabricated
`COMPLETED` or a guessed `FAILED` (TNA-48). Proven with a real killed-and-restarted process:
`deployment-shutdown.test.ts`'s "an action left EXECUTING by a killed process is recovered to
INDETERMINATE on restart" test.

## Restart policy (section 72)

`compose.production.yaml` sets `restart: on-failure:5` — bounded retries, not an infinite crash loop that
would mask a persistent configuration failure forever. A misconfigured production deployment (e.g. a
missing required secret) fails `tna-platform`'s own startup validation immediately and repeatedly, and
Compose gives up after 5 attempts rather than looping forever.

## Configuration immutability (section 73)

Config is loaded once, at process startup (`loadAppConfig()` in `main.ts`) — there is no file-watcher or
live-reload path. A running deployment's security-relevant configuration cannot change underneath it; a
configuration change requires a restart, which re-runs the full strict validation pass.

## Deployment identity (section 75)

`initDeploymentIdentity(dataDir, version)` generates `deployment_id` (`dep_<uuid>`) once, on first use,
and persists it to `deployment-identity.json` in the data directory — read-only on every subsequent
call. Every backup manifest and the `/diagnostics` output carry it, so a backup or a diagnostics snapshot
can always be traced back to the exact deployment that produced it.

## Backup requires a stopped deployment (recovery-consistency closure)

`npm run tna:backup` now refuses (`BackupQuiesceError`) while `tna-platform` is live — cross-component
consistency across five independently-updated component databases is provided by requiring the writer to
be stopped, not by an in-process quiesce protocol (see `deployment-backup-v0.1.md`). The operator
sequence is therefore:

```
docker compose -f deploy/compose/compose.production.yaml stop tna-platform
npm run tna:backup
docker compose -f deploy/compose/compose.production.yaml start tna-platform
```

This is a real, load-bearing correction to the original submission, which stated backup was safe and
unpaused against a live writer — true for any single file, not proven true for the set. See
`deployment-v0.1-recovery-consistency-closure.md`.

## Backup schedule / retention (section 108-110) — documented, not automated

v0.1 does not implement a cloud scheduler. Recommended operator cadence (to be wired into cron/systemd-
timer/CI by the operator, not built here): a daily backup, and always a backup immediately before any
upgrade (section 50). Retention/rotation of old backups is an operator policy decision, separate from —
and never a substitute for — Ledger evidence retention, which this milestone never silently shortens or
deletes (section 109). No GDPR-style broad deletion workflow is implemented in this volume (section 110)
— existing component semantics, unchanged, remain the only deletion behavior.

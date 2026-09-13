# TNA Pilot Deployment v0.1 — Storage Map

Every file listed below was confirmed present, on the correct mounted volume, inside the real running
pilot containers (`docker exec ... ls -la /data`) — not inferred from source alone.

## tna-platform (volume: `tna-pilot-platform-data` -> `/data`)

| File | Purpose | Backup |
|---|---|---|
| `tna-platform.sqlite` | Platform's own durable control-plane store (actions, outbox) | Included |
| `tna-ledger.sqlite` | The shared evidence backbone Platform writes to | Included |
| `tna-platform-gate.sqlite` | Platform's own in-process Gate store (agents, envelopes, decisions) | Included |
| `tna-platform-sentinel.sqlite` | Platform's own in-process Sentinel runtime | Included |
| `tna-platform-auditor.sqlite` | Platform's own in-process, post-hoc Auditor runtime (distinct from the standalone `tna-auditor` app, which is not deployed — see the security checklist item B) | Included |
| `deployment-identity.json` | Deployment identity record (`initDeploymentIdentity`) | Included (small, non-secret) |
| `RUNNING.lock` | Live-process lock; must NOT exist for `createBackup`/`restoreBackup` to proceed | N/A — presence is the gate, not backed-up content |
| `*.sqlite-wal`, `*.sqlite-shm` | SQLite WAL-mode side files | Not individually meaningful — `VACUUM INTO` (see below) reads a consistent snapshot regardless of their live state |

**Backup mechanism**: the accepted Volume 9 tool, unmodified — `npm run tna:backup` (wraps
`createBackup()` in `packages/deployment-ops`). **This tool is Platform-specific**: it resolves its target
directory via `apps/tna-platform/src/config.ts`'s `loadAppConfig()`, so it only ever backs up Platform's
own `/data`. It refuses outright (`BackupQuiesceError`) while `RUNNING.lock` is live — the accepted
Volume 9 "stop-required coherent backup" model (see `deployment-backup-v0.1.md`), reused here exactly as
designed, not reinvented. **Restore**: `npm run tna:restore`, same stop-required discipline, with
manifest hash + `deployment_id`/version compatibility gates before anything is overwritten.

Ephemeral: no. Every file here is authoritative, durable state — none of it is safe to lose.

## tna-client-gateway (volume: `tna-pilot-client-gateway-data` -> `/data`)

| File | Purpose |
|---|---|
| `client.sqlite` | Tenant registry, service identities, MCP server/tool records (`ClientStore`) |
| `tna-client-gateway-gate.sqlite` | Client Gateway's **own, independent** in-process Gate store |
| `tna-client-gateway-sentinel.sqlite` | Client Gateway's own in-process Sentinel |
| `tna-client-gateway-ledger.sqlite` | Client Gateway's own, independent Ledger — **not the same file or event stream as Platform's `tna-ledger.sqlite`** (see the overview's blocker 2) |
| `tna-client-gateway-platform.sqlite` | Client Gateway's own in-process `PlatformStore` for its governed executions |

**Backup mechanism**: **no accepted, manifested backup tool exists for this component.** The Volume 9
`tna:backup`/`tna:restore` scripts are hardcoded to Platform's own config loader and cannot be pointed at
Client Gateway's data directory. The only available mechanism today is a raw, stop-required file copy of
the whole `tna-pilot-client-gateway-data` volume (`docker run --rm -v tna-pilot-client-gateway-data:/data
-v $(pwd)/backups:/backup alpine tar czf /backup/client-gateway-$(date +%s).tar.gz -C /data .`, with the
container stopped first for the same WAL-consistency reason Volume 9's own backup doc explains). This has
no SHA-256 manifest, no version-compatibility gate, and no `verifyBackup()` equivalent — a real,
documented gap relative to Platform's tooling, not silently presented as equivalent.

Ephemeral: no.

## tna-improvement-governor (volume: `tna-pilot-improvement-data` -> `/data`)

| File | Purpose |
|---|---|
| `improvement.sqlite` | Improvement proposal/lineage store |
| `improvement-gate.sqlite` | Its own in-process Gate store |
| `improvement-ledger.sqlite` | Its own in-process Ledger |
| `improvement-sentinel.sqlite` | Its own in-process Sentinel |

**Backup mechanism**: same gap as Client Gateway — no Volume 9 tool coverage; raw stop-required volume
copy only.

**Previously known reliability defect, now fixed (see the security checklist item K and overview finding
6)**: this component used to crash permanently on any restart against an already-populated
`improvement-gate.sqlite`. A narrow source fix to `packages/improvement-core/src/gate-integration.ts`
(TNA Volume 12 Post-Acceptance Reliability Remediation) makes restart against persisted Gate state safe,
verified live across 3 consecutive restart cycles against this exact volume. Restoring a backup of this
volume to a running container is therefore no longer expected to trigger a crash on the next restart.

Ephemeral: no.

## tna-control-center (volume: `tna-pilot-control-center-data` -> `/data`)

| File | Purpose |
|---|---|
| `control-center.sqlite` | Sessions, CSRF tokens, signup/reset tokens, incident acknowledgments, user accounts |

**Backup mechanism**: same gap — raw stop-required volume copy only. Losing this file loses all sessions
(everyone must log in again) and locally-created user accounts, but loses no authoritative evidence — the
Control Center is a BFF, not a system of record; every authoritative fact still lives in Platform's Ledger.

Ephemeral: partially. Sessions are safe to lose (re-login); user accounts are not (would need
re-provisioning via `control-center-create-user.js`).

## reverse-proxy / Caddy (volumes: `caddy-pilot-data`, `caddy-pilot-config`)

Holds Caddy's own ACME account key and issued certificate/key material for the real pilot hostname.
**Backup recommended** once a real certificate is issued, to avoid an unnecessary reissuance (rate limits)
after a container replacement — a raw stop-required volume copy is sufficient; nothing here is
authoritative product evidence.

Ephemeral: partially — losing it only costs one re-issuance cycle, not data.

## Summary: is any authoritative data ever in an ephemeral container layer?

**No.** Every SQLite file enumerated above lives on a named Docker volume, confirmed live via
`docker exec ... ls -la /data` inside each running container, never on the container's own writable
layer. `tna-platform` additionally runs with `read_only: true` + a `tmpfs` `/tmp`, which forces this by
construction for that component.

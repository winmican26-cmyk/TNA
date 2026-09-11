# TNA Deployment Engineering v0.1 Proof of Work

## Accepted Baseline

- Volumes 1-3 — TNA Gate v0.1-v0.3
- Volume 4 — VAD Engine v0.1
- Volume 5 — TNA Ledger v0.1
- Volume 6 — TNA Sentinel v0.1
- Volume 7 — TNA Auditor v0.1
- Volume 8 — TNA Platform Integration v0.1, including its distributed-evidence closure pass

All eight remain untouched. No accepted tag was moved or rewritten.

## Git State

- Branch: `trust-no-agent-main`
- HEAD entering this milestone: `a8bed9fa6470ac7cecd292c5f32db9c4272d9ae7` (the Volume 8 acceptance
  metadata commit)
- This milestone's work is currently uncommitted in the working tree, presented for review before any
  commit/tag step, per the workflow established by every prior volume.
- The unrelated untracked file `output/imagegen/tna-handoff-logo-concept-01.png` was not staged,
  modified, or deleted.

## Files Created

```
packages/deployment-schema/{package.json,src/index.ts}
packages/deployment-health/{package.json,src/index.ts}
packages/deployment-ops/{package.json,src/index.ts}
apps/tna-platform/src/{config,logging,health,diagnostics}.ts
scripts/{tna-init,tna-verify,tna-backup,tna-restore,smoke-deployment-v01,demo-deployment-v01}.ts
deploy/docker/Dockerfile
.dockerignore
deploy/compose/{compose.yaml,compose.production.yaml}
deploy/config/{Caddyfile,.env.example}
tests/deployment/{deployment-config,deployment-health,deployment-backup,deployment-restore,
  deployment-health-http,deployment-shutdown,deployment-container,deployment-upgrade,
  deployment-observability,deployment-abuse-cases}.test.ts
docs/deployment/{deployment-overview-v0.1,deployment-topology-v0.1,deployment-config-v1,
  deployment-secrets-v0.1,deployment-container-v0.1,deployment-networking-v0.1,
  deployment-health-v0.1,deployment-observability-v0.1,deployment-backup-v0.1,
  deployment-restore-v0.1,deployment-upgrade-v0.1,deployment-rollback-v0.1,
  deployment-operations-v0.1,deployment-threat-model-v0.1,deployment-verification-v0.1,
  deployment-requirement-matrix-v0.1,proof-of-work-deployment-v0.1,operator-runbook-v0.1,
  mcp-deployment-boundary-v0.1,deployment-principles-v0.1}.md
```

## Files Modified

- `apps/tna-platform/src/main.ts` — rewritten to load `DeploymentConfig` via the new strict loader
  instead of ad hoc `process.env[name] ?? ''` reads, wire structured logging, wire real health/metrics
  into `createPlatformServer`, generate/read the deployment identity, and acquire/release the running
  lock across graceful shutdown. The accepted Volume 8 orchestration wiring (Gate/Sentinel/Ledger/
  Auditor/Platform composition) is unchanged in substance — only how configuration and observability
  reach it changed.
- `apps/tna-platform/src/server.ts` — additive: `/live`, `/ready`, `/diagnostics`, `/metrics`, and
  `GET /v1/platform/outbox/dead-letters` routes, plus new *optional* fields on `PlatformServerDeps`
  (`health`, `metrics`, `startedAt`, `configHash`, `deploymentId`). Every existing route, its
  authentication requirement, and its response shape is unchanged — proven by the full, unmodified
  `platform-http.test.ts` (Volume 8) continuing to pass without a single edit.
- `package.json` — added `tna:init`, `tna:verify`, `tna:backup`, `tna:restore`,
  `smoke:deployment:v01`, `demo:deployment:v01` scripts.
- `package-lock.json` — regenerated (`npm install`) to register the three new workspace packages;
  this also corrected a pre-existing lockfile/workspace drift that `npm ci` (used by the Dockerfile)
  surfaced immediately on first real container build — see "Failing-First Defects Found."

No accepted Gate, VAD, Ledger, Sentinel, Auditor, or Platform *behavior* was altered.

## Deployment Architecture

See `deployment-overview-v0.1.md` and `deployment-topology-v0.1.md` for the full package/process
breakdown and topology diagram.

## Process Topology

One composed platform process (Gate/Sentinel/VAD/Ledger/Auditor remain accepted in-process library
integrations, exactly as Volume 8 built them) plus one reverse proxy in production. Chosen deliberately
over a services-per-component split, which would require inventing new, unaccepted network APIs for
components that have none today (`deployment-topology-v0.1.md`, "Process model").

## Container Model

Multi-stage `deploy/docker/Dockerfile`: `node:24-slim` builder (lockfile-deterministic `npm ci`, full
build, `npm prune --omit=dev`) → `node:24-slim` runtime carrying only `node_modules`, `dist/apps`,
`dist/packages`, and `package.json`. No tests, no scripts, no Git history, no `output/` in the image.
See `deployment-container-v0.1.md`.

## Non-Root Runtime

Reuses the official Node image's built-in `node` user (uid 1000). Proven with a real
`docker exec <container> id -u` against a real running container, asserted `!= 0`
(`deployment-container.test.ts`).

## Persistent Storage

One `TNA_DATA_DIR` mount (`/data` in the image); a named Docker volume in `compose.production.yaml`,
never the container's writable layer. Database ownership table in `deployment-topology-v0.1.md`.

## Configuration Model

`DeploymentConfig v1` (`packages/deployment-schema`) — see `deployment-config-v1.md` for the full field
list and every validation rule, each backed by a real test.

## Production / Development Separation

`deploy/compose/compose.yaml` (development: no TLS, port published directly, placeholder credentials
clearly marked) vs. `deploy/compose/compose.production.yaml` (TLS via Caddy, no direct port publish for
the platform, file-mounted secrets, read-only rootfs, resource limits, bounded restart policy) — visually
and structurally distinct files, not a flag toggling the same file.

## Secret Model

`SecretRef { source: 'env' | 'file', ref }`; resolved only at point of use; never included in the
`deployment_config_hash`; weak/default/duplicate production values rejected outright. See
`deployment-secrets-v0.1.md`.

## Service Authentication

Every mutating/most read routes require a bearer credential mapped to exactly one accepted role
(`platform-agent`/`platform-operator`/`platform-admin`/`platform-service`, unchanged from Volume 8);
`/diagnostics`, `/metrics`, and dead-letter inspection additionally require admin or service. `/live` and
`/ready` are the two deliberately unauthenticated, read-only, non-secret-leaking status routes.

## Network Exposure

Production: only the reverse proxy's `80`/`443` are host-published; `tna-platform` has no `ports:` entry
at all. See `deployment-networking-v0.1.md`.

## TLS / Reverse Proxy

Caddy (`deploy/config/Caddyfile`) — automatic HTTPS, explicit request-size bound, upstream timeouts, and
baseline security headers including `Strict-Transport-Security`.

## Trusted Proxy

`network.trust_proxy` is a topology declaration honestly scoped: not yet consumed for any authorization
decision in v0.1 (documented explicitly, not silently overstated) — `deployment-networking-v0.1.md`.

## Health / Readiness

`GET /live` (process alive) vs. `GET /ready` (mandatory dependencies healthy) — never conflated.
Mandatory: platform store, Gate, Sentinel, Ledger. Optional: Auditor (degrades without blocking
execution readiness). Proven over real HTTP against a genuinely closed Sentinel store (503) and a
genuinely closed Auditor store (200, DEGRADED) — `deployment-health-http.test.ts`.

## Component Dependency Model

See "Health / Readiness" above and `deployment-health-v0.1.md`'s degraded-state diagram.

## Version Compatibility

`COMPONENT_VERSIONS` tied to the real accepted git tags; `assertVersionCompatible` throws a named
`VersionIncompatibleError` on any mismatch — used by both restore and upgrade.

## Schema Migration

No new schema-migration engine was built — each accepted component keeps its own existing internal
`ALTER TABLE` discipline (section 38's explicit instruction). Volume 9 adds the *operational* upgrade
procedure around that, not a replacement for it. See `deployment-upgrade-v0.1.md`.

## Backup Architecture

`VACUUM INTO` per component database (never a raw file copy) into a hidden staging directory, hashed and
manifested (`BackupManifest v1`, now including `schema_versions`), then atomically published by renaming
the staging directory to its final `bkp_*` name. **Corrected by the Final Recovery-Consistency Review**:
the original submission's claim here — "consistent against a live WAL-mode writer" — was true per
individual file and incomplete for the whole set; `createBackup()` now refuses outright while the
deployment's `RUNNING.lock` is live, which is what actually makes the *set* coherent. See "Recovery-
Consistency Closure" below and `deployment-backup-v0.1.md`.

## Backup Integrity

Every file's SHA-256 and byte count are recorded and re-verified before restore; a missing manifest,
missing required field (including the new `schema_versions`), missing file, size mismatch, or hash
mismatch are all rejected with specific reasons. A failed/partial backup attempt is never published under
a restorable name at all (atomic staging-then-rename).

## Restore Architecture

Validate → check running lock → check deployment identity → check component *and* schema version
compatibility → copy. Only the last step is destructive, and only after every prior check passes (order
adjusted by the Final Recovery-Consistency Review to check identity before compatibility, per that
review's own stated sequence — both orderings always left the target directory untouched on any
rejection). See `deployment-restore-v0.1.md`.

## Restore Verification

`scripts/tna-restore.ts` runs a non-mutating Ledger integrity check immediately after restoring and
exits non-zero if it fails.

## Upgrade Procedure

Preflight → mandatory pre-upgrade backup → new image start → `tna:verify` → accept. See
`deployment-upgrade-v0.1.md` and `operator-runbook-v0.1.md` step 12.

## Rollback Procedure

Exactly one mechanism: restore the pre-upgrade backup. No in-place schema-downgrade claim is made. See
`deployment-rollback-v0.1.md`.

## Graceful Shutdown

Real SIGTERM handling: stop new outbox claims, stop accepting connections, close every store, release
the running lock, exit 0. Proven with a genuine `docker stop` sending a real SIGTERM to PID 1 inside a
real Linux container (`deployment-container.test.ts`) — the authoritative proof, since Node's SIGTERM
handling is documented-unreliable on native Windows (noted directly in `deployment-shutdown.test.ts`,
which still proves crash-recovery and stale-lock-reclaim behavior for real on this host).

## Crash Recovery

A process killed while an action is `EXECUTING` resolves that action to `INDETERMINATE` on the next real
restart — never a fabricated `COMPLETED` — proven with a genuine killed-and-restarted child process
(`deployment-shutdown.test.ts`).

## Structured Logging

Single-line JSON via `createLogger()`; mandatory redaction of secret-shaped fields and bearer-token-
shaped values before every write; no raw request input logged by default.

## Redaction

`packages/deployment-schema`'s `redact()`, applied to every log line and to `/diagnostics`. Proven with
two distinct leak shapes (name-based, value-based) in `deployment-observability.test.ts`.

## Metrics

Fixed, label-free `MetricsRegistry` (`actions_received_total`, `outbox_pending`, ... — the exact
section-61 set). `GET /metrics` (Prometheus text format) is admin/service-credential gated.

## Operator Diagnostics

`GET /diagnostics` — component versions, config hash, deployment id, bounded outbox counts, readiness
status. Never a raw config or secret value — proven by asserting no configured credential appears in the
serialized response.

## Dead-Letter Operations

`GET /v1/platform/outbox/dead-letters` — read-only. No "force mark delivered" mutation exists anywhere
in this milestone.

## Initialization

`npm run tna:init` (`scripts/tna-init.ts`) — validates config, creates every component database's
schema, generates the deployment identity, verifies data-directory permissions (POSIX). Never runs
implicitly from an API request.

## Start / Stop / Status

`docker compose ... up -d` / `docker stop` (or `compose down`) / `GET /live`, `GET /ready`,
`GET /diagnostics`. See `operator-runbook-v0.1.md`.

## Deployment Verification

`npm run tna:verify` (`scripts/tna-verify.ts`) — read-only: config, component health, Ledger integrity
(non-mutating), version-compatibility self-check.

## Deployment Smoke Test

`npm run smoke:deployment:v01` — boots a real isolated instance and drives one governed action through
it end to end over real HTTP.

## Container Integration Test

`tests/deployment/deployment-container.test.ts` — two tests, both building and running the actual
production image via the real Docker daemon, never a static inspection.

## Abuse Cases

`tests/deployment/deployment-abuse-cases.test.ts` (6) plus abuse-relevant assertions embedded in
`deployment-config.test.ts` (weak/default production secret, unknown-field smuggling) and
`deployment-restore.test.ts`/`deployment-backup.test.ts` (corrupt/incomplete/cross-deployment/version-
incompatible restore, backup path traversal).

## Threat Model

33 deployment-layer categories (`D1`-`D33`, `D31`-`D33` added by the Final Recovery-Consistency Review
closure below) in `deployment-threat-model-v0.1.md`, plus the explicit single-host distributed-deployment
limitation and the section-3 scope exclusions.

## Failing-First Defects Found

Two real defects caught by actually running against the real Docker daemon and the real package
manager, rather than assuming correctness from inspection:

1. `npm ci` (used by the Dockerfile's builder stage for a deterministic install) failed on the very
   first real container build with dozens of "Missing from lock file" errors — `package-lock.json` had
   drifted out of sync with the workspace graph (including, but not limited to, the three brand-new
   `@tna/deployment-*` packages) because prior local development relied on an already-populated
   `node_modules` and never re-ran `npm install` after adding new workspace packages. `npm test`/
   `npm run build` never surfaced this, because neither depends on lockfile consistency — only `npm ci`
   strictly validates it. Fixed by running `npm install` once to regenerate the lock file; re-verified
   with a full, clean `npm ci`-based container build.
2. The deployment demo's Gate envelope for the `demo.echo.execute` action initially used
   `resource_kind: 'databases'` with an empty `resources.databases.read` allow-list and
   `operation: 'execute'` (not a valid `action_bindings.operation` value — the accepted set is
   `read|write|access|communicate`). Both mistakes were caught only by actually running the demo against
   the real Gate library (`ZodError`, then a real `BLOCK` decision) — fixed by using `resource_kind:
   'files'` with a matching `resources.files.read` glob pattern, mirroring the pattern Volume 8's own
   `demo-platform-v01.ts` already established for a working ALLOW flow.

Both were root-caused by comparing expected vs. observed output from real execution, not by inspection.

## Existing Regression Results

All 590 previously-accepted tests (Volumes 1-8, including the Volume 8 distributed-evidence closure)
remain green — verified as part of the 656-test full-suite run at the time of the original submission,
and as part of the 662-test full-suite run after the recovery-consistency closure below, not in
isolation, either time.

## Deployment Test Results

72 tests across 11 files in `tests/deployment/` (66 from the original submission + 6 from the closure) —
exact breakdown in `deployment-verification-v0.1.md`.

## Total Test Reconciliation

**Original submission**: 590 (accepted baseline) + 66 (new deployment tests) = 656. Node's test runner
reported exactly 656 tests, 656 passed, 0 failed, in both consecutive `npm run check` runs at that time.

**After the Final Recovery-Consistency Review closure** (see the dedicated section below): 656 + 6 new
closure tests = **662**. Node's test runner reported exactly 662 tests, 662 passed, 0 failed, in both
consecutive `npm run check` runs — no estimation, and the original 656 were not touched to reach this
number.

## First Clean Run

Original submission:

```
npm run check → 656 tests, 656 pass, 0 fail
Typecheck: PASS
Lint: PASS
Build: PASS
```

After the recovery-consistency closure:

```
npm run check → 662 tests, 662 pass, 0 fail
Typecheck: PASS
Lint: PASS
Build: PASS
```

## Second Clean Run (Repeatability, no cleanup between runs)

Original submission:

```
npm run check → 656 tests, 656 pass, 0 fail
```

After the recovery-consistency closure:

```
npm run check → 662 tests, 662 pass, 0 fail
```

(Both post-closure runs completed with the real Docker daemon and real container build/run tests
included, never a skipped/mocked container step; the second run was faster than the first thanks to
Docker's own build-layer cache.)

## Demo Output

```
npm run demo:deployment:v01
```

**Original submission** printed every required line for all six flows, including Flow 4 backing up
against a still-live deployment. **After the recovery-consistency closure**, Flow 4 and Flow 5 were
reordered — `STATE MODIFIED` then `SERVICES STOPPED` then `BACKUP CREATED`/`BACKUP VERIFIED` (Flow 4),
and Flow 5 now stops the deployment before creating and tampering its own backup, then restarts it
afterward to prove `ACTIVE STATE UNCHANGED` against a real, freshly-restarted instance rather than an
instance that was simply never touched — because `createBackup()` now correctly refuses to run against a
live deployment. Every other flow, and every other required line, is unchanged: Flow 1 (Clean Boot:
`CONFIG VALIDATED` through `READINESS PASS`), Flow 2 (Governed Action: `ACTION SUBMITTED` through
`LEDGER EVIDENCE VERIFIED`, a genuine Gate `ALLOW`), Flow 3 (Restart: real `SERVICES STOPPED`/`SERVICES
STARTED`, `PRIOR ACTION RECONSTRUCTED`), Flow 4 (now: `STATE MODIFIED` → `SERVICES STOPPED` → `BACKUP
CREATED` → `BACKUP VERIFIED` → `BACKUP RESTORED` → `SERVICES STARTED` → `PRIOR ACTION RECOVERED` →
`LEDGER INTEGRITY PASS`, including genuinely destroying the live `tna-platform.sqlite` file), Flow 5 (now:
`SERVICES STOPPED` → `BACKUP TAMPERED` → `RESTORE REJECTED` → `SERVICES STARTED` → `ACTIVE STATE
UNCHANGED`, this time proven by reconstructing the original action against a freshly restarted process),
and Flow 6 (Degraded Component, unchanged). `TNA Deployment Engineering v0.1 demo passed.` (exit code 0),
run twice post-closure for repeatability with identical results. Every outcome is genuinely computed by
real Gate/Sentinel/Ledger/deployment-ops code against real (temp-directory, real SQLite) data — none of
the six flows' results are hardcoded or asserted without having actually run.

## Recovery-Consistency Closure (Final Recovery-Consistency Review)

This addendum records a second, later architectural review of the 656/656 submission above — it does not
alter or delete anything above; the original result stands exactly as recorded, obtained before this
review, against the platform's original per-file-only backup consistency model.

**Finding, reproduced as real**: `VACUUM INTO` proves each individual database file is internally
consistent at the moment it is snapshotted. It does not prove that the *set* of files produced by several
sequential `VACUUM INTO` calls represents one coherent recovery point — while the original submission's
`createBackup()` ran, a live writer could (and, in the original submission's own demo Flow 4, genuinely
did) mutate Platform/Ledger/Sentinel/Gate/Auditor state between the first file's snapshot and the last
one's. This was reproduced directly, not assumed: the original demo backed up a live, still-serving
deployment before ever stopping it.

**Chosen model**: stop-required backup, not an in-process live-quiesce protocol. `createBackup()` now
refuses outright (`BackupQuiesceError`) while the deployment's own `RUNNING.lock` is live — mirroring the
exact discipline `restoreBackup()` already applied. A live in-process quiesce mode (reject new work,
drain in-flight requests, resolve uncertain work, flush the outbox, snapshot, then resume) was considered
and rejected: it would require a new intra-process admin/control protocol — new deployment-feature
surface — for a guarantee the stop-then-backup discipline already provides with none. Full analysis:
`deployment-v0.1-recovery-consistency-closure.md`.

**Pending outbox semantics**: unaffected in substance, reconfirmed under the new model — a committed
action with its Ledger evidence obligation still genuinely `PENDING` survives destroy-and-restore intact,
with the same deterministic Ledger event id, and the restarted dispatcher resumes and delivers it. Not
every outbox record is required to be `DELIVERED` before a backup is taken.

**All-or-nothing backup creation**: added. Every snapshot now writes into a hidden staging directory;
the manifest is written last; the whole directory is atomically renamed to its final publishable name
only once every step succeeds. A deliberately-induced partial failure (one of five component databases
made unreadable mid-set) now publishes no `bkp_*` directory at all, and leaves the live deployment's own
files completely untouched.

**Restore ordering**: reordered to check deployment identity before version/schema compatibility,
matching the review's own stated sequence (both orderings already left the target untouched on any
rejection — this is a sequencing correction, not a new destructive-order defect that was found).

**Manifest**: gained a `schema_versions` field (see `deployment-backup-v0.1.md` for why it is, honestly,
identical to `component_versions` today), now checked as an independent compatibility gate by
`restoreBackup()`.

**Truthful terminology applied**: neither this document, the backup docs, nor the code comments describe
the backup set as a globally ACID snapshot, a distributed transaction, or a point-in-time atomic snapshot
across independently-running systems. The accurate description used throughout: *a quiesced, verified
deployment backup set containing individually consistent component database snapshots from one
controlled recovery boundary.*

**New permanent regression tests** (6, all newly added, none replacing or weakening an existing test):
`tests/deployment/deployment-backup-consistency.test.ts` — cross-component quiesced backup refused/
succeeds; restore-while-writers-active refused/succeeds against a real live process; partial backup
creation failure produces no valid manifest; version-incompatible restore rejected before replacement
with a proven-clean retry; full cross-component recovery with a pending obligation, through the real
deployment; manifest field-binding/tamper-invalidation including `schema_versions`.

**Existing tests affected**: none removed or weakened. `scripts/demo-deployment-v01.ts`'s Flow 4/Flow 5
were reordered (not weakened — Flow 5 now proves "active state unchanged" against a freshly restarted
real process rather than an instance that was simply never touched, which is strictly stronger evidence)
to match the corrected, now-enforced backup precondition.

## Remaining Limitations

- Single-host baseline: no HA, no multi-region replication, no automatic failover, no managed
  disaster-recovery replica (`deployment-threat-model-v0.1.md`).
- Base image pinned by tag, not content digest (`deployment-container-v0.1.md`).
- No SBOM generation, no vulnerability scan wired into `npm run check` — both explicitly optional per
  the governing brief (sections 115-116).
- No dedicated rate limiter beyond size/timeout bounds; no claim of internet-scale DDoS resistance
  (section 71, explicit).
- `trust_proxy` is a topology declaration only — forwarded headers are not yet consumed for any
  authorization/rate-limiting decision (`deployment-networking-v0.1.md`, `deployment-threat-model-v0.1.md`
  category D8).
- No dead-letter manual-retry mechanism (section 65's read-only inspection is implemented; a retry path
  is explicitly deferred, with its required identity/causation-preservation constraint documented in
  advance for whoever builds it).
- v0.1 has no external customer IAM — a single static demo-style agent credential remains the only agent
  identity mechanism, unchanged in spirit from Volume 8 and explicitly out of scope to expand here
  (section 3).
- No frontend, no cloud/managed-container orchestration platform, no billing, no customer onboarding —
  all correctly out of scope for this milestone and not attempted.

## Requirement Scorecard

Full item-by-item scoring against the section-137 acceptance gate, plus the Final Recovery-Consistency
Review's own section-13 checklist, is in `docs/deployment/deployment-requirement-matrix-v0.1.md`.
Summary: every mandatory item — including every recovery-consistency item — is IMPLEMENTED and TESTED;
the small number of explicitly optional/deferred items (image digest pinning, SBOM, dedicated rate
limiting, dead-letter retry) are documented scope boundaries, not silent gaps.

## Mandatory Blockers Remaining

**0**

## Final Git Status

Branch `trust-no-agent-main`, HEAD `a8bed9fa6470ac7cecd292c5f32db9c4272d9ae7` (unchanged by this
milestone). New Volume 9 files are currently untracked/uncommitted; `apps/tna-platform/src/main.ts`,
`apps/tna-platform/src/server.ts`, `package.json`, and `package-lock.json` are modified in place
(additive). No accepted Gate, VAD, Ledger, Sentinel, Auditor, or Platform file was deleted or
destructively modified; `main` and all eight accepted tags (`tna-gate-v0.1/v0.2/v0.3`,
`vad-engine-v0.1`, `tna-ledger-v0.1`, `tna-sentinel-v0.1`, `tna-auditor-v0.1`, `tna-platform-v0.1`) are
untouched. `tna-deployment-v0.1` remains untagged.

## Recommendation

> **READY FOR ARCHITECTURAL ACCEPTANCE REVIEW**

This implementation agent does not declare acceptance, and does not tag `tna-deployment-v0.1`.
Acceptance belongs to the reviewer.

---

## Architectural Acceptance

Status:
ARCHITECTURALLY ACCEPTED AS TNA DEPLOYMENT ENGINEERING v0.1
WITH DOCUMENTED SCOPE AND LIMITATIONS

Accepted implementation commit:
3803c4694ed054fb43b7a9cf7897bd70e642f42c

Accepted tag:
tna-deployment-v0.1

Tag target:
3803c4694ed054fb43b7a9cf7897bd70e642f42c

Accepted test baseline:
662 / 662

Repeatability:
Two consecutive `npm run check` runs passed.

Smoke:
`npm run smoke:deployment:v01` — PASS

Demo:
`npm run demo:deployment:v01` — 6 / 6 PASS

Real container verification:
PASS (non-root, read-only rootfs, fresh boot, repeat boot, real SIGTERM, readiness)

Mandatory blockers remaining:
0

### History preserved

656 / 656 initial Volume 9 candidate
→ architectural recovery review
→ live multi-database backup inconsistency reproduced
→ stop-required backup model
→ staging + atomic publication
→ pending outbox restore proof
→ restore-before-replacement validation ordering
→ 6 permanent recovery closure tests
→ 662 / 662
→ architectural acceptance

Nothing above this section was rewritten to make the reproduced backup-consistency defect appear to have
never existed. The original 656/656 submission, the recovery-consistency review's finding and fix, and
this acceptance record all stand together as the full history of this milestone — exactly as Volume 8's
own distributed-evidence closure preserved its own history before its acceptance.

### Accepted limitations (unchanged by acceptance)

Architectural acceptance does not erase any of the following — they remain accurate, documented
boundaries of v0.1, not silent gaps:

- Single-host, SQLite-based — not HA, not multi-region replication, no automatic failover, no managed
  disaster-recovery replica.
- Not Kubernetes production infrastructure, not managed cloud infrastructure.
- No claim of internet-scale DDoS mitigation — only application- and proxy-level resource bounds.
- Not HSM/KMS-backed by default — secrets resolve from an environment value or a mounted file only.
- Not automated disaster-recovery replication — a backup restored by an operator is the only recovery
  mechanism for total single-host loss, and (per the recovery-consistency closure) requires the
  deployment to be stopped while the backup is taken.
- Not external-customer-IAM complete — a single static demo-style agent credential remains the only
  agent identity mechanism in v0.1.
- Not a production/compliance certification of any kind.
- Base image pinned by tag (`node:24-slim`), not by content digest.
- No SBOM generation, no vulnerability scan wired into `npm run check` (both explicitly optional per the
  governing brief).
- No dedicated application rate limiter beyond size/timeout bounds.
- No dead-letter manual-retry workflow (read-only inspection only).
- `trust_proxy` is a topology declaration only — forwarded headers (`X-Forwarded-For`/`-Proto`) are not
  yet consumed for any authorization or rate-limiting decision.

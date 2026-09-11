# TNA Deployment Engineering v0.1 — Verification

## Test breakdown

72 tests across 11 files in `tests/deployment/` (66 from the original submission + 6 from the Final
Recovery-Consistency Review closure):

| File | Tests | Covers |
|---|---:|---|
| `deployment-config.test.ts` | 21 | `DeploymentConfig v1` strict validation matrix, secret resolution, weak-secret detection, config hash, env-var loader, redaction |
| `deployment-health.test.ts` | 9 | liveness/readiness aggregation, degraded/fail-closed semantics, `runProbe` error bounding, metrics registry, Prometheus rendering |
| `deployment-backup.test.ts` | 5 | `VACUUM INTO` snapshot + hashing, corrupt/partial/missing-manifest rejection, backup path-traversal safety |
| `deployment-restore.test.ts` | 5 | real end-to-end restore with genuine data equality, running-lock enforcement + stale-lock reclaim, version-mismatch rejection, cross-deployment rejection/override |
| `deployment-health-http.test.ts` | 7 | `/live`, `/ready`, `/diagnostics`, `/metrics`, dead-letter route — real HTTP, real Gate/Sentinel/Ledger/Auditor stack |
| `deployment-shutdown.test.ts` | 3 | real child-process SIGTERM/SIGKILL, running-lock lifecycle, EXECUTING→INDETERMINATE recovery through the real entrypoint |
| `deployment-container.test.ts` | 2 | real `docker build`+`run`: non-root, fresh-machine boot, real `docker stop` SIGTERM, repeat boot, read-only rootfs |
| `deployment-upgrade.test.ts` | 4 | pre-upgrade backup validation, upgrade-failure rollback with real data equality, version-compatibility gate |
| `deployment-observability.test.ts` | 4 | structured-log redaction (two leak shapes), bounded-cardinality metrics under load |
| `deployment-abuse-cases.test.ts` | 6 | weak production secret, unknown-field smuggling, world-writable data dir (POSIX), corrupted DB file, backup path traversal, no accidental Ledger-writer HTTP route |
| `deployment-backup-consistency.test.ts` | 6 | **recovery-consistency closure** — backup/restore refused against a real live deployment and succeeds once stopped; partial backup creation produces no valid manifest and leaves live data unchanged; version-incompatible restore rejected before replacement with a proven-clean retry; a full cross-component recovery with a pending Ledger evidence obligation surviving destroy-and-restore through the real deployment; manifest-field (including `schema_versions`) tampering invalidates the set |

## What "real" means here, concretely

- **Real containers**: `deployment-container.test.ts` runs `docker build`/`docker run`/`docker exec`/
  `docker stop`/`docker start` against the actual production image — not a static Dockerfile read.
- **Real processes**: `deployment-shutdown.test.ts` and the deployment demo spawn
  `dist/apps/tna-platform/src/main.js` as a genuine OS child process and send it real signals.
- **Real SQLite**: every backup/restore test operates on genuine `node:sqlite` `DatabaseSync` files, using
  `VACUUM INTO`, not mocked file I/O.
- **Real HTTP**: `deployment-health-http.test.ts` and the smoke/demo scripts issue real `fetch()` calls
  against a real listening `http.Server`.

## Existing regression baseline

All 656 previously-accepted tests (Volumes 1-8 plus this volume's original 66) remain green — verified
as part of the 662-test full-suite run, not in isolation. None were removed, weakened, or skipped to
accommodate the recovery-consistency closure.

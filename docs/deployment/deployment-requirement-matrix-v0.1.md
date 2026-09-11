# TNA Deployment Engineering v0.1 — Requirement Matrix

Scored against the section-137 acceptance gate. IMPLEMENTED+TESTED unless noted. Extended below with the
Final Recovery-Consistency Review's own checklist (that review's section 13).

| Requirement | Status | Evidence |
|---|---|---|
| All 656 baseline tests remain green (590 original + 66 from this volume's first submission) | ✅ | `npm run check`, twice — see proof-of-work |
| Deterministic container build | ✅ | `deploy/docker/Dockerfile`, `npm ci` + lockfile; `deployment-container.test.ts` |
| Non-root container execution proven | ✅ | `docker exec ... id -u` != 0, real container |
| Persistent volumes explicit | ✅ | `TNA_DATA_DIR` → `/data`, named volume in `compose.production.yaml` |
| Production/dev config separated | ✅ | `compose.yaml` vs `compose.production.yaml`, distinct by design and comment header |
| Strict configuration validation exists | ✅ | `parseDeploymentConfig`, 21 tests |
| Insecure production defaults rejected | ✅ | CORS `*`, unbound-0.0.0.0, weak/default secrets — all throw |
| Secret reference model exists | ✅ | `SecretRef { source: env\|file, ref }` |
| Secret leakage tests pass | ✅ | log redaction, diagnostics redaction, no-secret-in-hash tests |
| Service credentials are least-privilege scoped | ✅ | operator/admin/service/agent roles unchanged from Volume 8; `/diagnostics`/`/metrics` admin-or-service only |
| External/internal port model documented | ✅ | `deployment-topology-v0.1.md`, `deployment-networking-v0.1.md` |
| TLS strategy exists | ✅ | Caddy termination, `deploy/config/Caddyfile` |
| Trusted proxy behavior defined | ✅ | documented explicitly, including the honest "not yet consumed for authorization" limitation |
| CORS production behavior secure | ✅ | default `null`, `*` rejected in production |
| Liveness implemented | ✅ | `GET /live` |
| Readiness implemented | ✅ | `GET /ready`, mandatory-vs-optional dependency model |
| Degraded health represented | ✅ | `AVAILABLE\|DEGRADED\|UNAVAILABLE` |
| Mandatory dependency outage fails safe | ✅ | Sentinel-down → 503, proven over real HTTP |
| Version metadata exists | ✅ | `COMPONENT_VERSIONS`, `/diagnostics` |
| Compatibility checks exist | ✅ | `assertVersionCompatible`, `VersionIncompatibleError` |
| Schema migration discipline documented/implemented where needed | ✅ | `deployment-upgrade-v0.1.md` — explicitly does not rewrite each accepted component's own existing discipline |
| Consistent backup implemented | ✅ | `VACUUM INTO`, never raw file copy |
| Backup manifest + hashes exist | ✅ | `BackupManifest v1`, SHA-256 per file |
| Real restore proven | ✅ | genuine data destroyed and recovered, `deployment-restore.test.ts` |
| Corrupt backup rejected | ✅ | one-byte-flip test |
| Incomplete backup rejected | ✅ | missing-Ledger-file test |
| Upgrade procedure exists | ✅ | `deployment-upgrade-v0.1.md`, `deployment-upgrade.test.ts` |
| Rollback procedure exists | ✅ | "restore pre-upgrade backup" — `deployment-rollback-v0.1.md`, no false claim of schema-downgrade support |
| Upgrade-failure behavior tested | ✅ | corrupted-mid-upgrade + restore test |
| Graceful shutdown exists | ✅ | real SIGTERM, proven in a real container |
| Restart recovery works | ✅ | lock reclaim + `recoverInterruptedWork()`, real process kill/restart |
| Uncertain in-flight execution remains INDETERMINATE | ✅ | real process kill test |
| Structured logs exist | ✅ | `createLogger`, JSON lines |
| Secret redaction proven | ✅ | `deployment-observability.test.ts` |
| Bounded metrics/diagnostics exist | ✅ | label-free `MetricsRegistry`, curated `/diagnostics` |
| Dead-letter inspection exists | ✅ | `GET /v1/platform/outbox/dead-letters` |
| Dead-letter retry, if implemented, preserves identity/causation | N/A | not implemented in v0.1 — documented as a future-work constraint, not silently deferred |
| Operator runbook complete | ✅ | `operator-runbook-v0.1.md` |
| Deployment smoke works | ✅ | `npm run smoke:deployment:v01` |
| Deployment demo works | ✅ | `npm run demo:deployment:v01`, 6/6 flows |
| Real container topology tested | ✅ | `deployment-container.test.ts` |
| Fresh-machine initialization tested | ✅ | brand-new named volume per container test run |
| Repeat boot tested | ✅ | `deployment_id` unchanged across stop/start on the same volume |
| Deployment threat model complete | ✅ | `deployment-threat-model-v0.1.md` |
| Requirement matrix complete | ✅ | this document |
| Proof of work complete | ✅ | `proof-of-work-deployment-v0.1.md` |
| Check passes twice | ✅ | 656/656, both runs, no cleanup between |
| No frontend | ✅ | none built |
| No cloud managed architecture | ✅ | none built |
| No billing | ✅ | none built |
| No Kubernetes production platform | ✅ | none built |
| No unrelated feature expansion | ✅ | scope held to deployment engineering only |

## Final Recovery-Consistency Review checklist

| Requirement | Status | Evidence |
|---|---|---|
| Cross-component backup consistency question answered explicitly | ✅ | reproduced as real (not hypothetical): sequential `VACUUM INTO` calls against a live writer do not, by themselves, prove the *set* is coherent — `deployment-v0.1-recovery-consistency-closure.md` |
| One explicit v0.1 model chosen and enforced | ✅ | stop-required backup: `createBackup()` refuses while `RUNNING.lock` is live |
| Backup does not fabricate execution certainty | ✅ | moot by construction under the stop-required model; any interrupted execution still resolves honestly to `INDETERMINATE` via unchanged Volume 8 recovery |
| Outbox obligations survive the backup boundary | ✅ | pending (undelivered) obligation backed up, destroyed, restored, resumed, delivered — same deterministic event id |
| Cross-component recovery regression | ✅ | `deployment-backup-consistency.test.ts`, "cross-component recovery" — real deployment, all 13 steps |
| Backup generation is all-or-nothing | ✅ | staging directory + atomic rename; a partial failure publishes nothing |
| Partial backup creation failure tested | ✅ | deliberately-failing Sentinel snapshot mid-set; no `bkp_*` published, live data unchanged |
| Restore remains offline with respect to writers | ✅ | demonstrated against a real live process: refused while running, succeeds once stopped |
| Deployment identity survives correctly | ✅ | unchanged existing protection, reconfirmed; cross-deployment restore still rejected without `force` |
| Backup manifest binds the whole recovery set | ✅ | `schema_versions` added; every bound field checked present; tampering any one invalidates the set |
| Version compatibility checked before replacement | ✅ | reordered restore sequence — schema/component compatibility both checked before any file is copied |
| Truthful backup terminology | ✅ | "globally ACID"/"distributed transaction"/"point-in-time atomic across all systems" language never used; corrected wording applied throughout |
| Focused permanent regression tests added | ✅ | `deployment-backup-consistency.test.ts` (6) — see `deployment-verification-v0.1.md` |
| Existing 656 tests preserved | ✅ | none removed or weakened |

## Known partial / explicitly out-of-scope items (not silent gaps)

- **Image digest pinning** — base image pinned by tag (`node:24-slim`), not content digest. Documented
  follow-up (`deployment-container-v0.1.md`).
- **SBOM / vulnerability scan** — not generated/run in this milestone (sections 115-116 mark both
  optional/recommended, not required).
- **Rate limiting** — no dedicated limiter beyond size/timeout bounds; no public unauthenticated write
  surface exists to protect beyond the bearer-auth boundary itself (`deployment-networking-v0.1.md`).
- **Trusted-proxy header consumption** — `trust_proxy` is a topology declaration; forwarded headers are
  not yet consumed for any authorization/rate-limit decision (`deployment-networking-v0.1.md`).
- **Dead-letter manual retry** — not implemented; documented as a future-work constraint.

None of these block the mandatory acceptance gate above — each is explicitly optional/deferred in the
governing brief (sections 3, 70-71, 115-116) and is stated here rather than hidden.

# TNA Deployment Engineering v0.1 Threat Model

Status per category: MITIGATED, PARTIALLY MITIGATED, or NOT MITIGATED (explicit, by design or by
scope). "Mitigated" means a deterministic control exists and is tested — not that the category is
impossible. Continues the numbering discipline from `platform-threat-model-v0.1.md` (categories 1-39);
this document covers deployment-layer categories only.

| # | Threat | Status | Detail |
|---|---|---|---|
| D1 | Secret exposure in logs | MITIGATED | `redact()` scrubs every secret-shaped field name and bearer-token-shaped value before any log line is emitted; proven with both leak shapes — `deployment-observability.test.ts` |
| D2 | Secret exposure in diagnostics/config dumps | MITIGATED | no `/config` route exists at all; `/diagnostics` returns a curated field set, additionally passed through `redact()`; proven by asserting no configured credential value appears anywhere in the response — `deployment-health-http.test.ts` |
| D3 | Insecure production defaults | MITIGATED | CORS `*`, an unbound `0.0.0.0` listener without a trusted proxy, a missing production capability key, and known-weak/short/duplicate secret values are all rejected at startup — `deployment-config.test.ts`, `deployment-abuse-cases.test.ts` |
| D4 | Misconfiguration (unknown/malformed fields silently accepted) | MITIGATED | `parseDeploymentConfig` rejects any field outside its fixed allowed-key list at every nesting level, and every value is range/type-checked — `deployment-config.test.ts`, `deployment-abuse-cases.test.ts` |
| D5 | Service impersonation between platform and its dependencies | PARTIALLY MITIGATED | Gate/Sentinel/Ledger/Auditor are in-process library instances, not network services, in this milestone's chosen topology (section 7) — there is structurally no network identity to impersonate between them; this status will need revisiting if a future milestone splits them into independently deployed services |
| D6 | Internal-port exposure | MITIGATED | `compose.production.yaml` publishes no port for `tna-platform` at all — only the reverse proxy is published; proven by design inspection of the compose file plus the real container test never publishing that port |
| D7 | TLS termination error / missing TLS | MITIGATED (by design) | TLS terminates only at Caddy via its automatic-HTTPS mechanism; the development compose file (no TLS) is visually and structurally distinguished from the production one, preventing accidental production use |
| D8 | Forwarded-header (X-Forwarded-For/Proto) spoofing | NOT MITIGATED (documented, low current impact) | `trust_proxy` is a topology declaration only in v0.1 — no authorization or rate-limiting decision currently consumes these headers, so spoofing one currently has no security effect, but this must be revisited the moment any such decision is added — see `deployment-networking-v0.1.md` |
| D9 | Cross-tenant configuration bleed | MITIGATED (by construction) | `DeploymentConfig` carries exactly one `tenant_id`; nothing in this milestone introduces a multi-tenant config file format — unchanged from Volume 8's own per-process tenant scoping |
| D10 | World-writable persistent storage | MITIGATED (POSIX) | `initDeploymentIdentity`/`tna-init` create the data directory and identity file with restrictive modes (`0o700`/`0o600`), verified directly — `deployment-abuse-cases.test.ts` (skipped on Windows, where POSIX mode bits are not meaningful; verified for real inside the Linux container by the real container test's environment) |
| D11 | Container root-escape impact | MITIGATED | the container runs as a non-root user (uid 1000) with a read-only root filesystem and no elevated capabilities requested (`no-new-privileges: true` in `compose.production.yaml`) — proven directly for non-root and read-only-rootfs; `no-new-privileges` is set but not independently re-verified beyond Docker's own enforcement of the flag |
| D12 | Compromised container | NOT MITIGATED (by design) | identical posture to every accepted TNA milestone (see `platform-threat-model-v0.1.md` #29) — if the platform's own runtime is compromised, its own conclusions cannot be trusted |
| D13 | Compromised host | NOT MITIGATED (by design) | identical posture to every accepted TNA milestone (see `platform-threat-model-v0.1.md` #30); a party with direct volume/host access can rewrite the platform's own store — this is exactly what Ledger integrity verification and Auditor's evidence-integrity qualification exist to catch for the evidence they consume |
| D14 | Backup theft | PARTIALLY MITIGATED | backups contain no secret values (only database content and a config hash) and are written with restrictive file permissions (POSIX); they are not encrypted at rest in v0.1 — an operator storing backups off-host is responsible for transport/storage encryption, not yet automated here |
| D15 | Backup corruption (accidental) | MITIGATED | every backup file is SHA-256 hashed at creation and re-verified before any restore; a size or hash mismatch is rejected outright — `deployment-backup.test.ts` |
| D16 | Backup/restore poisoning (deliberately tampered backup) | MITIGATED | identical mechanism to D15 — a deliberately flipped byte is caught by the same hash check before restore ever touches live data — `deployment-backup.test.ts`, `deployment-restore.test.ts` |
| D17 | Version-mismatch restore/upgrade | MITIGATED | `assertVersionCompatible` refuses with a named `VersionIncompatibleError`, never a generic/opaque database error — `deployment-restore.test.ts`, `deployment-upgrade.test.ts` |
| D18 | Schema-migration/upgrade failure leaving half-migrated state | MITIGATED | a pre-upgrade backup is the recovery path; a corrupted-mid-upgrade live store is fully recoverable from it with real before/after data equality proven — `deployment-upgrade.test.ts` |
| D19 | Rollback failure / false claim of downgrade safety | MITIGATED (by honest scope) | v0.1 makes no claim of in-place schema downgrade; the only documented and tested rollback mechanism is restoring the pre-upgrade backup — `deployment-rollback-v0.1.md` |
| D20 | Log secret leakage | MITIGATED | see D1 |
| D21 | Metrics label-cardinality leakage (request/action/tenant ids as labels) | MITIGATED | every metric is label-free by construction; proven under 500 simulated increments producing exactly one output line — `deployment-observability.test.ts` |
| D22 | Startup race between dependent services | MITIGATED | `compose.production.yaml`'s reverse proxy uses `depends_on: condition: service_healthy` against the platform's own real `/live` healthcheck, not a fixed process-start ordering |
| D23 | Dependency outage (Ledger/Gate/Sentinel/Auditor unavailable) | MITIGATED | mandatory-dependency outage fails `/ready` closed (503); optional (Auditor) outage degrades without blocking execution readiness — proven over real HTTP against a genuinely closed store, both directions — `deployment-health-http.test.ts` |
| D24 | Stale readiness (reporting healthy after a dependency actually failed) | MITIGATED | `/ready` runs its probes fresh on every request — there is no cached/stale readiness state to go stale |
| D25 | Unsafe shutdown / lost evidence during shutdown | MITIGATED | graceful shutdown stops new outbox claims immediately and never steals or falsely completes another owner's lease; proven with a real `docker stop` SIGTERM — `deployment-container.test.ts`, `deployment-shutdown.test.ts` |
| D26 | Outbox lease recovery after a killed process | MITIGATED | inherited directly from Volume 8's distributed-evidence closure (durable lease + fencing token); re-exercised through the real deployable entrypoint by the restart/recovery tests here, not re-implemented |
| D27 | Operator misuse of the restore command (accidental production overwrite) | MITIGATED | `tna restore` refuses to run at all without an explicit `--force` flag or `TNA_CONFIRM_RESTORE=yes` — no silent default "yes" |
| D28 | Operator-supplied path traversal (backup source/destination) | MITIGATED | `assertSafePath` rejects `../../`, an absolute escape, and a symlink escape via the nearest existing ancestor — `deployment-backup.test.ts`, `deployment-abuse-cases.test.ts` |
| D29 | Denial of service (resource exhaustion via oversized/slow requests) | PARTIALLY MITIGATED | application- and proxy-level size/timeout bounds exist (unchanged Volume 8 application limits, plus Caddy's own `max_size`/timeout settings); **no claim of internet-scale DDoS resistance is made** — explicitly out of scope (section 71) |
| D30 | Unbounded container restart loop masking a persistent failure | MITIGATED | `restart: on-failure:5` — bounded, not infinite |
| D31 | Cross-component backup incoherence (a backup set assembled from independently-mutating component databases, sequentially snapshotted, mistaken for one coherent recovery point) | MITIGATED (recovery-consistency closure) | reproduced as real, not hypothetical, in the Final Recovery-Consistency Review — the original per-file `VACUUM INTO` consistency claim did not extend to the whole set while a writer stayed live; `createBackup()` now refuses outright while `RUNNING.lock` is live, guaranteeing no component database can be mutating while any other is snapshotted; proven with a real live process refused, then a real stopped-process backup restoring a genuinely coherent recovery point end to end — `deployment-backup-consistency.test.ts`, `deployment-v0.1-recovery-consistency-closure.md` |
| D32 | Partial backup creation mistaken for a valid, restorable backup | MITIGATED (recovery-consistency closure) | every snapshot is written to a hidden staging directory and the manifest last; only a successful full set is atomically renamed to its publishable name — a failure partway through (a corrupted/unreadable source database) leaves no `bkp_*` directory at all, proven with a deliberately failing component snapshot — `deployment-backup-consistency.test.ts` |
| D33 | In-flight execution forced to a fabricated COMPLETED/FAILED outcome to make backup easier | MITIGATED (by the chosen model) | moot by construction under the stop-required backup model — there is no live execution at all at backup time; any execution the stop itself interrupted resolves to `INDETERMINATE` on the next restart via the unchanged Volume 8 `recoverInterruptedWork()` mechanism (TNA-48/53), never a fabricated result |

## Distributed-deployment limitation

**TNA Deployment Engineering v0.1 is a single-host baseline.** It does not provide high availability,
multi-region replication, automatic failover, or a managed disaster-recovery replica. A backup restored
by an operator is the only recovery mechanism for total single-host loss. This is the same honesty
discipline every prior TNA volume has applied to its own distributed-transaction and exactly-once
limitations (see `platform-threat-model-v0.1.md`) — stated here explicitly rather than implied by
omission.

## Not attempted in this milestone (by explicit scope, section 3)

Frontend/dashboard security, billing security, customer-signup abuse, multi-region/cluster security,
Kubernetes-specific hardening, managed-SaaS control-plane security, enterprise SSO, full external
customer IAM, auto-scaling-fleet security, service-mesh security, cloud-provider-specific IAM. None of
these were built, so none of them are claimed secure or insecure here — they simply do not exist yet.

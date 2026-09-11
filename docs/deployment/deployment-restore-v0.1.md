# TNA Deployment Engineering v0.1 — Restore

## Procedure (section 43, reordered by the recovery-consistency closure — section 11)

`restoreBackup(backupDir, dataDir, opts)` (`packages/deployment-ops`), in this exact order:

1. **Validate the backup** — `verifyBackup()`; refuses on any invalid/corrupt/incomplete result before
   touching `dataDir` at all.
2. **Check for a live owner** — `isRunningLockActive(dataDir)`; refuses (`DeploymentLockError`) if a live
   process still holds `RUNNING.lock` (section 99: never restore over actively mutating SQLite files).
3. **Check deployment identity** — refuses to silently restore a backup from a different
   `deployment_id` into an existing, differently-identified data directory unless `force: true` is passed
   explicitly (section 44).
4. **Check version and schema compatibility** — `assertVersionCompatible(manifest.component_versions)`
   *and* `assertVersionCompatible(manifest.schema_versions)`; refuses (`VersionIncompatibleError`) on any
   mismatch against this build's own `COMPONENT_VERSIONS`/`SCHEMA_VERSIONS` (section 100 — an explicit,
   named error, never a generic database-corruption symptom later).
5. **Copy** — only after all four checks pass does any file in `dataDir` get overwritten. Never "replace
   live state first and discover incompatibility afterward" (section 11) — proven directly by rejecting
   a tampered/incompatible backup and then, immediately afterward, confirming the original data is still
   present *and* that a corrected retry restores cleanly (`deployment-backup-consistency.test.ts`).

(The original submission checked version compatibility before deployment identity; the recovery-
consistency review's section 11 asked for identity before compatibility. Both orderings already left
`dataDir` untouched on any failure — the reorder makes the check sequence match the review's own stated
order exactly, it does not change what is or isn't destructive.)

`scripts/tna-restore.ts` (`npm run tna:restore -- --backup <id> [--force] [--cross-deployment]`) wraps
this with an additional confirmation gate (section 81): it refuses to run at all unless `--force` is
passed or `TNA_CONFIRM_RESTORE=yes` is set — a noninteractive override, not an interactive prompt (this
tool has none), but still an explicit, deliberate signal, never a default "yes."

## Restore must not mix deployments (section 44)

Every backup manifest carries the `deployment_id` it was taken from. Restoring it into a data directory
with a *different* existing `deployment_id` is refused unless the operator explicitly passes `--force` /
`{ force: true }` — proven directly in `deployment-restore.test.ts` (`restore refuses to silently mix a
backup from a different deployment without an explicit force`).

## Post-restore verification

`scripts/tna-restore.ts` runs `verifyLedgerIntegrity(ledgerStore, { persist: false })` immediately after
a successful restore and exits non-zero if the restored Ledger fails its own hash-chain verification
(reusing the accepted `ledger-integrity` package — no new integrity algorithm was written).

## Restore while writers are active (section 8 of the recovery-consistency review)

Demonstrated against a **real, live, spawned `main.js` process** (not just a library-level lock check):
attempting `restoreBackup()` while the deployment is genuinely running and serving HTTP throws
`DeploymentLockError`, and the still-live deployment's `/ready` continues returning 200 immediately
afterward — the rejected attempt leaves it completely unaffected. Stopping the process for real and
retrying then succeeds. See `deployment-backup-consistency.test.ts`, "restore while writers are active is
refused."

## Pending outbox obligations survive the backup boundary (section 4-5 of the recovery-consistency review)

A committed platform action with its Ledger evidence obligation still genuinely `PENDING` (never
dispatched — the deployment is killed well within the dispatcher's 2-second tick interval) is backed up,
the live databases are destroyed outright, and the backup is restored: the same `PENDING` outbox record
—  with its original deterministic Ledger event id — survives, the restarted dispatcher resumes and
delivers it, and Ledger integrity passes afterward. There is no requirement that every outbox record be
`DELIVERED` before a backup is taken — only that the durable obligation itself, and its causal identity,
survive intact. See `deployment-backup-consistency.test.ts`, "cross-component recovery," which runs this
entire sequence — governed action → pending obligation → backup → destroy → restore → restart →
readiness → reconstruct → resume delivery → Ledger integrity — through the real deployable entrypoint.

## Tests

`deployment-restore.test.ts` (5): a full real restore (genuine actions created, backed up, the live
`.sqlite` files destroyed outright, restored, and reconstructed — matching data, matching Ledger
evidence, not just "some bytes restored"); restore-requires-stopped-writers (a live lock refuses restore,
a released lock allows it); a stale lock from a dead process is reclaimed automatically (never a
permanent lockout); version-mismatch rejection with a named `VersionIncompatibleError`; cross-deployment
rejection without `force`, success with it.

`deployment-backup-consistency.test.ts` (6, recovery-consistency closure — see also
`deployment-backup-v0.1.md`): restore-while-writers-active against a real live process; the full
cross-component pending-obligation recovery sequence described above; version-incompatibility rejected
before replacement with a proven-clean corrected retry; manifest-field tampering (including the new
`schema_versions` field) invalidating the set.

`deployment-upgrade.test.ts` (4) exercises the same mechanism from the upgrade-procedure angle — see
`deployment-upgrade-v0.1.md`.

# TNA Deployment Engineering v0.1 — Rollback

## What is supported (section 51)

**Rollback support in v0.1 is exactly one mechanism: restore the pre-upgrade backup.** There is no
schema-downgrade path, no "undo migration" tooling, and no claim that rolling an image tag back to an
older version is safe against a data directory a newer version has already written to. This is stated
plainly rather than implied:

> If a downgrade is unsafe, state "restore pre-upgrade backup" as the rollback mechanism (section 51).

That is exactly what this milestone does. `scripts/tna-restore.ts` is the one rollback tool; it is the
same command used for disaster recovery (`deployment-restore-v0.1.md`). There is no separate
"rollback-specific" code path to maintain or drift out of sync with restore's own tested guarantees.

## Why not more

A general schema-downgrade engine would need to reverse every accepted component's own internal
`ALTER TABLE` history — a much larger undertaking than this milestone's mandate, and one that risks
silently corrupting data a `DEAD_LETTER` outbox record or a partially-delivered Ledger stream depends on
being append-only. Restoring a known-good, hash-verified backup is a strictly safer guarantee than an
attempted in-place downgrade, and it is the guarantee this milestone actually implements and tests
(`deployment-upgrade.test.ts`'s upgrade-failure-rollback test).

## Operator procedure

See `operator-runbook-v0.1.md`, "Rollback" section — stop the new version, `tna:restore` the pre-upgrade
backup, start the old version, `tna:verify`.

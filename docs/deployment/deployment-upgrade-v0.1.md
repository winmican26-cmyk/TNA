# TNA Deployment Engineering v0.1 — Upgrade

## What v0.1's upgrade model actually is (section 49)

`DeploymentConfig` is a fixed `version: '1'` schema — there is no deployment-config schema migration
engine in this milestone, because none is needed yet. Each accepted component (`PlatformStore`,
`LedgerStore`, etc.) already owns its own internal `ALTER TABLE`-per-column migration discipline,
established across Volumes 5-8 and carried forward unchanged (most recently, Volume 8's distributed-
evidence closure pass added the outbox lease columns this exact way). Volume 9 does not rewrite that
discipline — section 38 is explicit: "If current accepted components already manage their own schema
internally, do not rewrite them in this volume."

What Volume 9 adds is the **operational procedure** around an upgrade — new code (a new image tag)
replacing the running process:

```
current version → target version → preflight → backup → migration (component startup) →
start → health verification → accept
```

## Upgrade must start with backup (section 50)

A validated, restorable backup must exist before an upgrade is attempted — proven directly
(`deployment-upgrade.test.ts`, "a validated pre-upgrade backup exists and is provably restorable before
any migration is attempted"). The operator runbook (`operator-runbook-v0.1.md`) states this as the first
step of its upgrade procedure, not an optional one.

## Upgrade failure behavior (section 52)

If the new code fails during its own startup migration/schema work (leaving the live data directory in
some unusable intermediate state), the pre-upgrade backup restores the **exact** prior state — proven
directly with real evidence: `deployment-upgrade.test.ts`'s failure test seeds a real action, backs it
up, corrupts the live `tna-platform.sqlite` file outright (simulating a crashed partial migration), then
restores and confirms the original action and its Ledger evidence are both present and unchanged. There
is no half-migrated silent startup — `PlatformStore`'s own constructor either succeeds cleanly against a
consistent file or throws; nothing in this milestone papers over a partially-written schema.

## Version compatibility as the upgrade guard

An upgrade to an incompatible component-version combination is rejected explicitly via
`assertVersionCompatible()` / `VersionIncompatibleError` — never run silently. This is the same mechanism
`deployment-restore-v0.1.md` documents; upgrade and restore share one compatibility gate rather than two
independently-maintained ones.

## Tests

`deployment-upgrade.test.ts` (4): pre-upgrade backup validated; upgrade-failure rollback with real
before/after data equality; incompatible version combination rejected; this build's own version
combination accepted (a self-consistency check).

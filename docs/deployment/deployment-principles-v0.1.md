# TNA Principles TNA-51 – TNA-56 (Volume 9 — TNA Deployment Engineering v0.1)

TNA-01 through TNA-50 are preserved unchanged — TNA-43 through TNA-50 are consolidated in
`docs/platform/platform-principles-v0.1.md`; earlier ones remain documented inline within their own
respective volumes' docs. Nothing in this document supersedes or restates them.

The following six principles are established by this milestone's real implementation — each is backed by
a specific, tested mechanism, not merely asserted.

## TNA-51 — Secure Code Is Not Secure Deployment

A correctly implemented control can still fail if it is deployed with insecure credentials, networking,
filesystem permissions, or configuration. Established by `packages/deployment-schema`'s strict
`DeploymentConfig` validation, which fails startup on a weak/default secret, an insecure CORS wildcard,
an unbound listener without a trusted proxy, or a world-writable data directory — the same accepted
Gate/Sentinel/Ledger/VAD/Auditor code from Volumes 1-8 would enforce every one of its own controls
correctly even while running with any of those deployment-layer mistakes.

## TNA-52 — Readiness Is a Security Decision

A process being alive is not sufficient evidence that it is safe to accept consequential work.
Established by `GET /live` vs. `GET /ready`'s deliberate separation (`packages/deployment-health`): a
mandatory dependency (Gate, Sentinel, Ledger, the platform's own store) being unavailable fails readiness
closed (503), even though the process itself is still very much alive and answering `/live`.

## TNA-53 — Recovery Must Preserve Truth

Restart, restore, and rollback must not convert uncertain or failed operations into fabricated success.
Established by: a process killed mid-execution resolving to `INDETERMINATE` on restart, never a
fabricated `COMPLETED` (`deployment-shutdown.test.ts`); a restore that fails any of its validation gates
touching nothing (`deployment-restore.test.ts`); and rollback being defined as exactly one honest
mechanism — restoring a known-good backup — rather than an unproven in-place schema downgrade
(`deployment-rollback-v0.1.md`).

## TNA-54 — Backups Are Part of the Trust Boundary

Evidence and control state that cannot survive infrastructure loss are not durable assurance.
Established by the backup/restore mechanism itself: a hashed, manifested, `VACUUM INTO`-based snapshot
of every component database, verified before it is ever trusted for restore, proven against genuine
infrastructure loss (the live `tna-platform.sqlite` file destroyed outright and fully recovered) in both
`deployment-restore.test.ts` and the deployment demo's Flow 4.

## TNA-55 — Configuration Is Executable Authority

Deployment configuration changes what agents, services, and operators can do; configuration therefore
belongs inside the security model. Established by treating `DeploymentConfig` with the same rigor as any
other security-relevant input this project has ever validated — a strict, fail-closed parser
(`parseDeploymentConfig`) that rejects unknown fields, out-of-range values, and unsafe production
defaults outright, cited explicitly in `packages/deployment-schema/src/index.ts`'s own file header.

## TNA-56 — Operational Convenience Must Not Manufacture Trust

Health checks, retries, restarts, migration tools, and operator workflows must not bypass the same
controls enforced during normal execution. Established by construction: `/live` and `/ready` are
read-only status surfaces that cannot submit, approve, or terminate an action; `tna:verify` never mutates
production work; `tna:restore` requires explicit confirmation and still runs through the exact same
`PlatformStore`/Ledger code paths as ordinary operation, never a privileged bypass; the running-process
lock and outbox lease recovery mechanisms recover a legitimate owner's work, they do not grant any new
authority beyond what Volume 8's own accepted CAS/lease model already allowed.

# TNA Recursive Improvement Governance v0.1 — Rollback

Source of truth: `packages/improvement-schema/src/index.ts` (`RollbackPolicy`, `ROLLBACK_TRIGGERS`,
`ROLLBACK_STATUSES`, `RollbackRecord`), `packages/improvement-store/src/index.ts`
(`initiateRollback`/`completeRollback`/`listRollbacks`), and `apps/tna-improvement-governor/src/server.ts`
(`handleRollback`, `verifyRollbackTarget`).

## Pre-bound rollback target

`RollbackPolicy` (part of `ImprovementSpec`) carries `rollback_generation_id` (a pre-declared fallback
target, may be `null`) and `auto_rollback_triggers` (a subset of the fixed `ROLLBACK_TRIGGERS` vocabulary:
`SECURITY_REGRESSION`, `SENTINEL_TERMINATE_THRESHOLD`, `ERROR_RATE`, `COST_EXPLOSION`,
`LATENCY_THRESHOLD`, `EVIDENCE_FAILURE`, `UNEXPECTED_CAPABILITY`, `CANARY_HEALTH_FAILURE`). In practice the
actual `rollback_target_generation_id` used is supplied explicitly at rollback time (via the HTTP/CLI
`target`/`--target` parameter), not silently inferred.

## Rollback trigger

`RollbackRecord.trigger` is either one of the eight named triggers above or the literal `'MANUAL'` — the
operator CLI's `improvement rollback` command currently always sends `'MANUAL'` (there is no CLI flag to
select a different trigger reason in v0.1; the real HTTP API accepts any of the eight). The trigger value
is recorded for evidence purposes; it does not by itself change how the rollback is verified.

## Rollback confirmation

`ImprovementStore.initiateRollback(tenantId, generationId, rollbackTargetGenerationId, trigger,
initiatedBy)` first validates that BOTH the generation being rolled back AND its target genuinely belong to
`tenantId` — `getGeneration()` throws `NOT_FOUND` for either otherwise. **This tenant-ownership check was a
real vulnerability fixed during this volume's closure**: it did not originally exist, meaning a caller
could reference another tenant's generation id as a rollback target. Tested in `tenant-isolation.test.ts`.

At the HTTP/CLI layer, `improvement rollback`/`improvement promote` both require `--confirm <exact
generation id>` (mirroring Volume 11's `tenant offboard` fat-finger-prevention pattern) plus a mandatory
`--reason`, enforced before the underlying HTTP call is even made.

## Real verification, not fabrication

`initiateRollback()` always starts the new `RollbackRecord` in status `INDETERMINATE` — there is no
constructor path that starts it any other way. The governor's `handleRollback` then calls a real
`verifyRollbackTarget(targetGenerationId)`:

```ts
function verifyRollbackTarget(targetGenerationId: string) {
  const targetWorkspaces = workspacesByGeneration.get(targetGenerationId);
  const targetPath = targetWorkspaces?.candidateWorkspacePath ?? targetWorkspaces?.parentWorkspacePath;
  if (!targetPath || !existsSync(targetPath)) return { verified: false, reason: '...cannot confirm restored state' };
  return { verified: true, reason: '...workspace exists and is reachable' };
}
```

**This is a real, if minimal, check** — it confirms the target generation's tracked workspace still exists
on disk. It is honestly documented as a workspace-EXISTENCE check, not a full content-hash re-verification
of the rollback target's integrity (see the proof-of-work document's limitations section). This was itself
a real bug fixed during this volume's closure: `handleRollback` originally called
`completeRollback('ROLLED_BACK', ...)` **unconditionally**, with no verification step at all.

## Failed rollback / INDETERMINATE

If `verifyRollbackTarget` reports `verified: false`, the rollback record is left `INDETERMINATE`
(`completeRollback` is never called) and the generation itself is transitioned to `INDETERMINATE` — never
`ROLLED_BACK`. **The correct claim is never fabricated in either direction**: an unverifiable rollback
target results in `INDETERMINATE`, not a false "rollback succeeded" and not a false "rollback definitely
failed." Tested in E2E J: *"when the rollback target cannot be verified, the result is INDETERMINATE, never
fabricated ROLLED_BACK."*

If verification succeeds, `completeRollback(tenantId, rollbackId, 'ROLLED_BACK', reason)` is called — a
SQL-level guard (`WHERE status='INDETERMINATE'`) means this can only ever resolve a rollback record exactly
once; a second attempt to complete an already-resolved record is a `CONFLICT`, never a silent overwrite.

## Promotion-vs-rollback races

Both `PROMOTED -> ROLLED_BACK` (the only legal outgoing edge from `PROMOTED`) and the CAS-protected
`state_version` on every generation record mean a promote and a rollback racing against the same generation
resolve deterministically: the first commit wins, the second gets `CONFLICT`. `concurrency.test.ts`
explicitly tests the TNA-33 requirement that a stronger safety state (e.g. a completed rollback) is never
silently overwritten by a stale, weaker one arriving after it.

## History preservation

A `RollbackRecord` is never deleted. `listRollbacks(tenantId, generationId)` returns every rollback record
ever initiated for a generation, in order. A rolled-back generation's own record remains queryable
(`getGeneration`) with status `ROLLED_BACK` permanently — rollback removes nothing from history, it only
adds a new terminal state and a new, permanent evidence record. Tested in E2E E: *"parent remains accepted,
failed candidate history retained."*

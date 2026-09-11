# TNA Platform Action State Machine v0.1

## States (section 9)

```
RECEIVED, AUTHORIZING, BLOCKED, HELD, AUTHORIZED, CAPABILITY_ISSUED,
MONITORING, EXECUTING, VERIFYING, COMPLETED, FAILED, TERMINATED, INDETERMINATE
```

Terminal: `BLOCKED, COMPLETED, FAILED, TERMINATED, INDETERMINATE` (section 10).

## Allowed transitions

```ts
RECEIVED:          ['AUTHORIZING']
AUTHORIZING:       ['BLOCKED', 'HELD', 'AUTHORIZED', 'INDETERMINATE']
BLOCKED:           []
HELD:              ['AUTHORIZING', 'TERMINATED']
AUTHORIZED:        ['CAPABILITY_ISSUED', 'INDETERMINATE', 'FAILED']
CAPABILITY_ISSUED: ['MONITORING', 'INDETERMINATE', 'FAILED']
MONITORING:        ['EXECUTING', 'TERMINATED', 'INDETERMINATE', 'FAILED']
EXECUTING:         ['VERIFYING', 'COMPLETED', 'FAILED', 'TERMINATED', 'INDETERMINATE']
VERIFYING:         ['COMPLETED', 'FAILED', 'INDETERMINATE']
COMPLETED / FAILED / TERMINATED / INDETERMINATE: []
```

`HELD -> AUTHORIZING` is the resume/approve path (an operator moves a held action back into the
authorization leg — the *next* Gate call re-derives ALLOW/BLOCK/HOLD fresh, never assumes approval
implies ALLOW). `HELD -> TERMINATED` is the explicit operator-terminate path for a held action.

`isAllowedTransition(from, to)` (`packages/platform-schema`) is the single source of truth this table
is generated from; `PlatformStore.transition()` enforces it on every call — an attempted transition
outside this table throws `INVALID_TRANSITION` rather than silently succeeding.

## Compare-and-swap (section 11, carried forward from Sentinel's TNA-33 lesson)

Every mutable row carries `state_version INTEGER`. Every write is `UPDATE ... WHERE state_version = ?`
inside a SQLite `BEGIN IMMEDIATE` transaction; a changed-row-count of anything but 1 is a `CONFLICT`,
never a silent no-op or a retried overwrite. This is what makes two concurrent execution claims,
concurrent terminate/complete races, and concurrent duplicate submissions all resolve to exactly one
winner (proven directly with genuinely concurrent `Promise.allSettled` calls, not sequential ones —
`tests/platform/platform-races.test.ts`).

## Specialized transition methods

Beyond the generic `transition()`, several methods combine a CAS transition with the evidence field
it durably binds in the **same** SQLite transaction — never a separate best-effort write:

- `recordGateDecision` — `AUTHORIZING -> {AUTHORIZED|BLOCKED|HELD}`, binds the exact Gate decision.
- `recordCapability` — `AUTHORIZED -> CAPABILITY_ISSUED`, binds `capability_id`.
- `recordSentinelSession` — `CAPABILITY_ISSUED -> MONITORING`, binds `sentinel_session_id`.
- `claimExecution` — `MONITORING -> EXECUTING`, the durable one-winner execution claim.
- `recordExecutionResult` — `EXECUTING -> {VERIFYING|COMPLETED}`, binds `execution_id`/`result_hash`.
- `recordVerificationResult` — `VERIFYING -> {COMPLETED|FAILED|INDETERMINATE}`, binds the VAD verdict.
- `recordFailure` — any non-terminal state `-> {FAILED|TERMINATED|INDETERMINATE}`, binds
  `error_code`/`error_message`.

## Restart recovery (section 99, 108-109)

On construction, `PlatformStore` sweeps any row left `EXECUTING` (a crash mid-connector-call, where
the real side effect's outcome is genuinely unknown) to `INDETERMINATE` — never silently `COMPLETED`.
Any outbox record left `DELIVERING` (a crash mid-Ledger-write) is requeued as `FAILED` with its
already-deterministic `ledger_event_id` intact, so the retry is a safe, idempotent Ledger no-op if the
write had actually landed (see `platform-outbox-v0.1.md`). Proven directly in
`tests/platform/platform-state.test.ts` and `platform-outbox.test.ts` by closing and reopening a real
SQLite-backed store mid-flight.

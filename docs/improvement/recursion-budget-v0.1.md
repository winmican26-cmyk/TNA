# TNA Recursive Improvement Governance v0.1 — Recursion Budget

Source of truth: `packages/improvement-schema/src/index.ts` (`RecursionLimits`, `RecursionBudget`,
`checkRecursionBudget`), `packages/improvement-store/src/index.ts`
(`getOrCreateRecursionBudget`/`consumeRecursionBudget`), and
`apps/tna-improvement-governor/src/server.ts` (`handleCreate`).

## Runtime-owned counters

```ts
interface RecursionBudget {
  system_id, tenant_id, limits: RecursionLimits,
  generation_count, attempt_count, runtime_used_ms, cost_used_usd,
  tool_calls_used, mutation_size_used_bytes, state_version,
}
```

```ts
interface RecursionLimits {
  max_generations, max_attempts_per_generation, max_runtime_per_attempt_ms, max_total_runtime_ms,
  max_cost_per_attempt_usd, max_total_cost_usd, max_tool_calls, max_external_calls,
  max_changed_files, max_changed_bytes,
}
```

The budget row is created once per system (`getOrCreateRecursionBudget`, keyed by the real internal
`system_id`, never the caller-facing name) and updated only via `consumeRecursionBudget`, which is a
CAS-protected additive delta operation — the caller supplies how much of which counter to add
(`{generations: 1}`, etc.), and the store atomically increments the stored counter and bumps
`state_version`, refusing (`CONFLICT`) if the caller's expected version is stale.

## The check is a hard stop, not advisory

`checkRecursionBudget(budget)` compares every counter against its limit and returns every reason
currently exceeded (`generation_count >= max_generations`, `attempt_count >= max_attempts_per_generation`,
`runtime_used_ms >= max_total_runtime_ms`, `cost_used_usd >= max_total_cost_usd`,
`tool_calls_used >= max_tool_calls`) — a caller never has to guess which limit was hit, since more than one
can be simultaneously true.

`apps/tna-improvement-governor/src/server.ts`'s `handleCreate` calls this check BEFORE any generation
record is created for a new proposal:

```ts
const budget = deps.store.getOrCreateRecursionBudget(deps.tenantId, system.system_id, recursionLimits);
const exhaustion = checkRecursionBudget(budget);
if (exhaustion.exhausted) {
  appendImprovementEvent(deps.ledger, deps.tenantId, 'RECURSION_BUDGET_EXHAUSTED', ...);
  throw new ImprovementError('BUDGET_EXHAUSTED', ...); // mapped to HTTP 429
}
```

Note: this check was NOT present in the packaged governor's `handleCreate` route at all until it was
added during this volume's own closure — a real, significant gap in an earlier build state, since the
pure `checkRecursionBudget()` function existed and was unit-tested from early in the volume, but nothing in
the HTTP layer was calling it. Tested end-to-end in E2E F ("recursion bound — the runtime, not the
candidate, stops further generations once the budget is exhausted") and at the store level in
`store.test.ts`.

## Why the candidate cannot increase its own budget

- **Generation count / attempt count**: incremented only by `consumeRecursionBudget`, called only from
  `handleCreate` (generations) and nowhere from any candidate-reachable code path for attempts in v0.1.
  There is no HTTP route or CLI command that lets a caller set `generation_count` or `attempt_count`
  directly — only additive consumption exists.
- **Runtime / cost / tool-call allowance**: same mechanism — these are consumed as measured (real spawned
  process runtime/cost/tool-call counts feed the additive deltas), never declared or self-reported by the
  candidate.
- **Mutation allowance** (`max_changed_files`/`max_changed_bytes`, on `ResourceLimits`/`RecursionLimits`
  rather than the budget's own live counters in v0.1): declared per-spec as a ceiling the orchestration
  enforces, not a value the candidate's own build output can widen — the actual changed-file/byte count is
  measured by `diffDirectoryTrees()`/`hashDirectoryTree()` over the real isolated workspace, not asserted
  by the candidate.
- **The limits object itself** (`RecursionLimits`) is supplied by the trusted caller at `propose()` time
  (`input.recursionLimits ?? DEFAULT_RECURSION_LIMITS`) — a candidate has no field through which its own
  proposal content can raise its OWN system's configured limits. Each system's budget is created once with
  whatever limits its first proposal specified; a later proposal cannot silently swap in a more generous
  limits object for an existing budget row (`getOrCreateRecursionBudget` only uses the supplied limits when
  first CREATING the row — an existing row keeps its original limits, matching what E2E F's tiny-budget
  scenario relies on).

## Real fix during this closure: budget was scoped correctly, but not always looked up correctly

The budget itself is correctly scoped per real internal `system_id`. However, a separate, related bug (see
`improvement-spec-v0.1.md`/`evaluation-profile-v0.1.md`'s cross-references) meant that
`ImprovementStore.createSystem()` always mints its own random `system_id`, and the packaged governor's
`handleCreate` originally could not reliably find an EXISTING system by the caller's chosen identifier —
silently creating a brand-new, disconnected system (and therefore a brand-new, unconsumed budget) on every
single `propose()` call. This defeated recursion-budget accumulation entirely until fixed (see the proof-
of-work document for the full account) — the budget mechanism itself was never wrong, but a system-identity
bug upstream of it made the budget appear to never accumulate.

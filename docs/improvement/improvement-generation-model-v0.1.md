# TNA Recursive Improvement Governance v0.1 — Generation Model

Source of truth: `packages/improvement-schema/src/index.ts` (`GENERATION_STATES`,
`GENERATION_TRANSITIONS`, `canTransition`, `ImprovementGeneration`) and
`packages/improvement-store/src/index.ts` (`ImprovementStore.createGeneration`/`transitionGeneration`/
`getLineage`).

## States

```
PROPOSED, AUTHORIZED, BUILDING, BUILT, EVALUATING, EVALUATED, REJECTED,
AWAITING_APPROVAL, CANARY, PROMOTED, ROLLED_BACK, FAILED, INDETERMINATE
```

## Legal transitions

| From | May transition to |
|---|---|
| `PROPOSED` | `AUTHORIZED`, `REJECTED` |
| `AUTHORIZED` | `BUILDING`, `REJECTED` |
| `BUILDING` | `BUILT`, `FAILED`, `INDETERMINATE` |
| `BUILT` | `EVALUATING` |
| `EVALUATING` | `EVALUATED`, `REJECTED`, `INDETERMINATE` |
| `EVALUATED` | `AWAITING_APPROVAL`, `REJECTED`, `CANARY` |
| `AWAITING_APPROVAL` | `CANARY`, `REJECTED` |
| `CANARY` | `PROMOTED`, `ROLLED_BACK`, `REJECTED`, `INDETERMINATE` |
| `PROMOTED` | `ROLLED_BACK` |
| `ROLLED_BACK` | *(none — terminal)* |
| `REJECTED` | *(none — terminal)* |
| `FAILED` | *(none — terminal)* |
| `INDETERMINATE` | *(none — terminal)* |

Every transition is enforced by `ImprovementStore.transitionGeneration()`, which checks
`canTransition(from, to)` before writing and throws `ImprovementError('CONFLICT', ...)` on an illegal
request — a caller cannot coerce a generation into an out-of-order state, and this is not a client-side
convention: it is checked server-side, inside the store, on every call.

## Explicitly prohibited transitions (illustrative, not exhaustive)

- `EVALUATED -> PROMOTED` directly — promotion must pass through `CANARY` first. (A CLI integration test
  originally attempted this and was correctly rejected by the real state machine; the test was fixed, not
  the state machine.)
- `EVALUATED -> EVALUATING` — evaluation is a one-way pipeline step; there is no re-entry into
  `EVALUATING` once a generation has left `BUILT`. A generation that needs re-evaluation (e.g. a Class 5
  `HOLD` outcome awaiting fresh human/independent-review approval flags) is re-evaluated *in place* from
  `EVALUATED` by the governor's HTTP layer — the real evaluation logic re-runs, but the generation's
  recorded status only changes if the newly-computed target actually differs from its current status
  (landing back on the same target, e.g. `HOLD` again or `PROMOTE` after previously `HOLD`, is a legitimate
  no-op, not a state transition).
- Any transition out of a terminal state (`REJECTED`, `FAILED`, `ROLLED_BACK`, `INDETERMINATE`) except
  `PROMOTED -> ROLLED_BACK`.
- `PROMOTED -> REJECTED` — a promoted generation can only be rolled back, never retroactively rejected.

## Lineage semantics

- **Parent identity**: `parent_generation_id` — `null` for a root generation (the first generation ever
  created for a system, or one deliberately bootstrapped as a baseline).
- **Root identity**: `root_generation_id` — set once at creation. If `parent_generation_id` is `null`, the
  new generation IS its own root. Otherwise it inherits the parent's `root_generation_id`.
- **Generation number**: `generation_number` — `0` for a root, `parent.generation_number + 1` otherwise.
  This is a real, store-computed sequence number, never caller-supplied.
- `ImprovementStore.createGeneration()` rejects a nonexistent parent, a cross-tenant parent (`NOT_FOUND` in
  both cases), and — by construction — a self-parent, since a generation's id is freshly minted at the
  moment of creation and cannot yet exist as anyone's parent.

## CAS / state-version handling

Every mutable record (`ImprovementSystem`, `ImprovementGeneration`, `RecursionBudget`, `CanaryRun`,
`AuthorityExpansionRequest`, `RollbackRecord`) carries a `state_version` integer. Every mutation call
(`transitionGeneration`, `consumeRecursionBudget`, `recordCanaryObservation`/`endCanaryRun`,
`decideAuthorityExpansionRequest`, `completeRollback`) requires the caller's expected version to match the
currently-stored version; a mismatch is a `CONFLICT`, never a silent overwrite. This is the same
optimistic-concurrency discipline used throughout every prior TNA volume (Gate's decision evidence,
Sentinel's session state, Ledger's stream heads) — applied here to every improvement-governance record.
Concurrent promote-vs-rollback and canary-success-vs-failure races are explicitly tested in
`tests/improvement/concurrency.test.ts`, including the TNA-33 requirement that a stronger safety state
(e.g. `ROLLED_BACK`) is never overwritten by a stale weaker one racing behind it.

## Cycle protection

`ImprovementStore.getLineage()` walks both the ancestor chain (root-first) and the full descendant set. A
legitimate insert path through `createGeneration()` cannot itself produce a cycle (a generation's parent
must already exist before the child is minted), but the ancestor and descendant walks both still carry an
explicit visited-set guard as defense in depth, throwing `ImprovementError('LINEAGE_CYCLE', ...)` if one is
ever encountered — tested directly in `tests/improvement/lineage.test.ts` against a hand-crafted
pathological row set (since the normal insert path cannot produce one to test against naturally).

## Terminal states, restated

`REJECTED`, `FAILED`, `ROLLED_BACK`, and `INDETERMINATE` are all terminal — no generation record is ever
deleted or reused after reaching one of these. Rejected and rolled-back generations' full history remains
queryable via the store and reconstructible from the Ledger (see `lineage-v0.1.md`); this is the "improvement
history is security evidence" principle (TNA-77).

# TNA Recursive Improvement Governance v0.1 — Lineage

Source of truth: `packages/ledger-query/src/index.ts` (`reconstructImprovementGeneration`,
`reconstructImprovementLineage`, `ImprovementGenerationReconstruction`, `ImprovementLineageNode`) and
`packages/improvement-store/src/index.ts` (`ImprovementStore.getLineage`).

## Two independent ways to reconstruct lineage

1. **From the store** (`ImprovementStore.getLineage(tenantId, generationId)`): walks the real
   `parent_generation_id` chain (ancestors, root-first) and every direct+transitive descendant, with an
   explicit cycle guard (see `improvement-generation-model-v0.1.md`).
2. **From the Ledger alone** (`reconstructImprovementGeneration`/`reconstructImprovementLineage`,
   `packages/ledger-query`): reconstructs the SAME information purely from real, hash-chained Ledger
   events, **never consulting `ImprovementStore` at all**. This is the proof that the store is not the sole
   source of truth for what happened — the same conclusion is independently derivable from the append-only
   evidence log.

## Concrete example

```
G0 (root, CLASS_0_CONFIG) ── proposed, authorized, built, evaluated PROMOTE, canary, PROMOTED
  │
  ├─▶ G1 (parent=G0) ── proposed, authorized, built, evaluated REJECT (e.g. authority escalation)
  │                     finalState: REJECTED
  │
  └─▶ G2 (parent=G0) ── proposed, authorized, built, evaluated PROMOTE, canary, PROMOTED
         │              (G2 is now the system's accepted_generation_id)
         │
         └─▶ G3 (parent=G2) ── proposed, authorized, built, evaluated PROMOTE, canary STARTED
                                canary observed real failures above threshold → CANARY FAILED
                                → ROLLED_BACK (G2 remains the accepted generation throughout)
```

Reading this from the Ledger alone: `reconstructImprovementGeneration(ledgerStore, tenantId, 'G1')` returns
`{proposed: true, authorized: true, built: true, evaluated: {...REJECT payload...}, finalState:
'REJECTED'}` — computed entirely from querying `stream_id: 'improvement:G1'`'s real events, in the order
they were actually appended. `reconstructImprovementGeneration(ledgerStore, tenantId, 'G3')` similarly
returns `finalState: 'ROLLED_BACK'` by finding the `IMPROVEMENT_ROLLED_BACK` event as the last matching
"final" event type in G3's own stream. Calling `reconstructImprovementLineage(ledgerStore, tenantId, ['G0',
'G1', 'G2', 'G3'])` returns a `nodes` array with each generation's own `{generationId,
parentGenerationId, finalState}` and a `roots` array (`['G0']`, since G0's parent is `null` and is the only
one whose parent is not itself in the supplied id set).

This exact scenario — parent-remains-accepted-after-child-rollback, with the failed candidate's history
retained — is what `tests/improvement/e2e-a-to-j.test.ts`'s E2E E scenario tests for real, and the
Ledger-reconstruction sanity check at the end of that same file additionally proves `proposed`/`authorized`/
`built` are all readable straight from real Ledger events for at least one real scenario in the suite.

## How this differs from a preconstructed lineage array

Nothing in this volume ever hands a caller a hand-assembled or cached "lineage tree" object as ground
truth. Every field returned by `reconstructImprovementGeneration`/`reconstructImprovementLineage` is
derived, on each call, by querying `LedgerStore.query(tenantId, {streamId: 'improvement:<id>'})` and
scanning the real event list for specific event types (`IMPROVEMENT_PROPOSED`, `IMPROVEMENT_AUTHORIZED`,
`IMPROVEMENT_BUILT`, `IMPROVEMENT_EVALUATED`, `CAPABILITY_DELTA_DETECTED`, `AUTHORITY_EXPANSION_*`, and the
terminal event types that determine `finalState`). If the underlying Ledger events were never actually
appended (e.g. a generation that was only ever created at the store level, bypassing the real HTTP
pipeline — as constructed deliberately in E2E J to simulate an untracked workspace), the reconstruction
honestly reflects that absence (`proposed: false`, `finalState: 'UNKNOWN'`) rather than inferring a history
that was never recorded.

## Honest limitation: no cross-stream discovery

`reconstructImprovementLineage()` takes a caller-supplied universe of generation ids — **Ledger has no
cross-stream "find all children of X" index**. A caller must already know which generation ids it wants
reconstructed (typically from `ImprovementStore.listGenerations()`, which the governor's `handleLineage`
route does before calling `reconstructImprovementLineage`). This is not a bug; it is the same honest
boundary every other Ledger-reconstruction function in this project respects — the Ledger proves history
for streams you ask about, it does not offer unbounded graph discovery across the whole tenant.

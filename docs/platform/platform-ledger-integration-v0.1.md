# TNA Platform — Ledger Integration v0.1

## Additive schema change (section 32, 116)

`packages/ledger-schema`: `SourceComponent` gained `'platform'`; `EVENT_TYPES` gained
`PLATFORM_ACTION_RECEIVED`, `PLATFORM_ACTION_BLOCKED`, `PLATFORM_ACTION_HELD`,
`PLATFORM_ACTION_AUTHORIZED`, `PLATFORM_EXECUTION_STARTED`, `PLATFORM_EXECUTION_COMPLETED`,
`PLATFORM_VERIFICATION_STARTED`, `PLATFORM_VERIFICATION_COMPLETED`, `PLATFORM_ACTION_TERMINATED`,
`PLATFORM_ACTION_INDETERMINATE`, `PLATFORM_ACTION_COMPLETED`, `PLATFORM_ACTION_FAILED`. Purely
additive — every event accepted under `tna-ledger-v0.1` remains valid; the tag is untouched.
`apps/tna-ledger/src/writers.ts` gained `platformWriter`/`platformLedgerReader`, following the exact
pattern Sentinel/Auditor established.

## Deliberately minimal event set (section 32's own instruction)

The platform emits one Ledger record per *meaningful* transition, not one per internal state hop.
`CAPABILITY_ISSUED` and `MONITORING` entry are recorded on the action row but never independently
Ledger-evidenced — the next event (`PLATFORM_EXECUTION_STARTED`, emitted at the durable execution
claim) carries `capability_id`/`sentinel_session_id` in its own payload, so the chain remains fully
reconstructable without a redundant record for every hop.

## A deliberate design choice, recorded honestly (not a silent gap)

The platform's Ledger events are its own `PLATFORM_*` wrapper facts — `platform` is the
`actor`/`source_component`, `correlation_id` is the action's own — not a re-emission of Gate's native
`AUTHORIZATION_ALLOWED`/`CAPABILITY_ISSUED`/`SENTINEL_SESSION_STARTED`/`EXECUTION_STARTED`/`ATOM_*`
event types. Auditor's existing v0.1 control catalog was built against those native event types; it
therefore returns `INSUFFICIENT_EVIDENCE` for most native-event-scoped controls when assessing a
platform-orchestrated `correlation_id` — an honest reflection that this specific evidence shape wasn't
captured under those event types for this action (TNA-35: missing evidence is a first-class result,
never fabricated success), not a defect. Demo Flow 6 and `platform-auditor-integration.test.ts` both
demonstrate this directly and do not require `PASS` (section 92's own explicit allowance). A future
milestone could additionally emit native event types for full cross-catalog Auditor compatibility —
documented as an explicit extension point, not built here, to keep this pass narrowly scoped.

## Reliable propagation

See `platform-outbox-v0.1.md` for how "platform state committed, Ledger temporarily unavailable" is
handled — this is the actual Volume 5-documented fragility Volume 8 was asked to fix.

## Causal linkage

Every `PLATFORM_*` event carries `correlation_id` (the action's own, constant across its lifetime) and,
where a Gate decision exists, `causation_id: gate_decision.decision_id` — so an independent reviewer
can reconstruct "this event happened *because of* that decision," not merely "at the same time as."
Proven directly: `platform-orchestration.test.ts`'s Ledger-dispatch test asserts both the causation
link and that every delivered event for one action shares its `correlation_id`.

# TNA Sentinel Ledger Integration v0.1

## Ledger schema extension (sections 57-58)

Ledger's `SourceComponent` and `EVENT_TYPES` registries (`packages/ledger-schema/src/index.ts`) were
extended additively:

- `SourceComponent` gained `'sentinel'`.
- `EVENT_TYPES` gained ten types: `SENTINEL_SESSION_STARTED, SENTINEL_VIOLATION_DETECTED,
  SENTINEL_WARNING, SENTINEL_HOLD, SENTINEL_TERMINATION_REQUESTED, SENTINEL_TERMINATED,
  SENTINEL_CONTAINMENT_FAILED, SENTINEL_EMERGENCY_STOP_ACTIVATED, SENTINEL_EMERGENCY_STOP_RELEASED,
  SENTINEL_SESSION_COMPLETED`.

No existing value was removed, renamed, or reordered — every event the accepted `tna-ledger-v0.1`
commit could validate still validates identically under this schema. The tag itself is untouched;
this is the branch evolving beyond it, exactly as section 58 anticipates. `apps/tna-ledger/src/
writers.ts` gained one new additive export, `sentinelWriter(tenantId)`, bound only to
`source_component: 'sentinel'`; `gateWriter`, `vadWriter`, `reader`, and `admin` are unmodified.

All 250 tests accepted before this milestone remain green after the extension (verified as part of
the full-suite run, not in isolation) — see `sentinel-verification-v0.1.md`. New schema-level tests
for the added source component and event types live in
`tests/sentinel/sentinel-adapters.test.ts`.

## Mapping (section 101)

`apps/tna-sentinel/src/ledger-adapter.ts`'s `SentinelLedgerAdapter` is a pure translation layer — it
never calls into `SentinelRuntime` and never alters Ledger's own validation, hashing, or chain
behavior. One stream per Sentinel session (`sentinel:<sentinel_session_id>`), independent of Gate's
own `agent:<agentId>` stream. `correlation_id` is the session's bound `decision_id` when one exists,
so a Sentinel violation correlates directly with the Gate decision it was defending; it falls back to
the session id otherwise.

| Sentinel event | Ledger event_type | When |
|---|---|---|
| session created | `SENTINEL_SESSION_STARTED` | at session creation |
| a rule match or evaluation error | `SENTINEL_VIOLATION_DETECTED` | per violation |
| decision WARN | `SENTINEL_WARNING` | |
| decision HOLD | `SENTINEL_HOLD` | |
| decision TERMINATE, before containment resolves | `SENTINEL_TERMINATION_REQUESTED` | |
| containment confirmed | `SENTINEL_TERMINATED` | |
| containment unconfirmed | `SENTINEL_CONTAINMENT_FAILED` | |
| stop activated | `SENTINEL_EMERGENCY_STOP_ACTIVATED` | |
| stop released | `SENTINEL_EMERGENCY_STOP_RELEASED` | |
| session reaches COMPLETED | `SENTINEL_SESSION_COMPLETED` | |

All writes use `sentinelWriter(tenantId)` — a governed agent, or any principal not bound to
`source_component: 'sentinel'`, cannot write these events; proven directly against the real `Ledger`
facade in `tests/sentinel/sentinel-adapters.test.ts`.

## Sentinel does not trust Ledger as live authority (sections 59, 64)

Ledger holds evidence about what already happened. It is never consulted to decide whether authority
is *currently* valid — that question goes to the `AuthorityRevalidator` abstraction
(`sentinel-runtime`), backed in practice by `GateAuthorityRevalidator` reading Gate's own live state.
Sentinel can only detect a revocation or policy change as quickly as whatever revalidation mechanism
is configured actually runs — there is no claim of instantaneous global revocation, and no background
scheduler ships in v0.1; `evaluateSession()` must be invoked (by an observation or by a periodic
caller) for a recheck to happen.

## Reconstruction (section 102)

A Sentinel session's full narrative — authorized action, observed drift, matched rule, decision,
containment outcome — is reconstructible directly from the events above plus the session's own
`listViolations`/`listDecisions`, without touching Ledger's broader reconstruction machinery. This
milestone does not redesign Ledger's `reconstructGateAction`/`reconstructVadAtom`; a
Sentinel-specific reconstruction view is left as documented future work rather than bolted on.

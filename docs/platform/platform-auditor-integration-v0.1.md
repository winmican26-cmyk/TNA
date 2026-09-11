# TNA Platform — Auditor Integration v0.1

## Post-hoc only (section 43, 79-80)

Auditor is never in the critical execution path — `PlatformExecutionOrchestrator.run()` never calls
into `AuditorRuntime`. Assessment is invoked explicitly, after the fact, via
`POST /v1/platform/actions/:id/audit`, using the action's own `correlation_id` and `agent_id` to scope
`TNA_BASELINE_V01` over the action's real time window.

## Discoverability (section 42)

Since `AuditorRuntime`'s `LedgerEvidenceProvider` reads the **same** Ledger database the platform's
outbox dispatcher writes to, any action whose evidence has been dispatched is discoverable by
`correlation_id` alone — no cross-referencing needed. Proven directly:
`platform-auditor-integration.test.ts` runs a full action to `COMPLETED`, dispatches its outbox, then
creates and runs a real `AssessmentSpec` scoped to that `correlation_id`.

## Truth stays layered (section 80-81)

Whatever Auditor concludes, the platform's own recorded execution state for the action is never
rewritten. `runPostHocAudit()` (`apps/tna-platform/src/server.ts`) returns
`{ execution_result: action.state, audit_outcome: {...} }` — two facts, side by side, never merged
into one. Proven directly in `platform-http.test.ts` and the demo's Flow 6.

## Expected outcome, and why `PASS` is not required (sections 91-92)

Because the platform emits its own `PLATFORM_*` wrapper events rather than Gate/Sentinel/VAD's native
event types (see `platform-ledger-integration-v0.1.md`), Auditor's existing catalog — built for those
native types — typically returns `INSUFFICIENT_EVIDENCE` for a platform-orchestrated action, honestly.
The demo and the dedicated test both assert only that a **real, independently computed** assessment is
produced, never that it is `PASS` — exactly section 92's instruction ("Do not require PASS if
documented limitations legitimately produce findings").

## Corrupt evidence still cannot produce clean assurance (End-to-end Test K, TNA-41)

`platform-auditor-integration.test.ts` carries the Auditor v0.1 trust-closure lesson forward
end-to-end: run an action to `COMPLETED`, dispatch its Ledger evidence, corrupt the action's own
Ledger stream via a simulated privileged database rewrite (identical technique to Auditor's own
accepted demo), then assess it. The outcome is never `PASS` — corrupt evidence cannot support an
unqualified passing result, regardless of which subsystem produced the underlying facts.

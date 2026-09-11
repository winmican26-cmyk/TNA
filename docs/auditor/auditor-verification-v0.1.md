# TNA Auditor v0.1 Verification

## Command

```bash
npm run check   # typecheck && lint && build+test
```

Run twice consecutively, no manual cleanup between runs.

## Observed output — Run 1

- Typecheck: PASS
- Lint: PASS
- Build: PASS
- Total tests: 526
- Passed: 526
- Failed: 0

## Observed output — Run 2 (immediately after, no cleanup)

- Total tests: 526
- Passed: 526
- Failed: 0

## Reconciliation against the accepted baseline

Baseline entering Volume 7: 406 tests (392 Sentinel-accepted baseline + 14 Sentinel concurrency-closure
tests, per `tna-sentinel-v0.1`'s acceptance). This milestone adds 120 Auditor tests across 11 files in
`tests/auditor/`:

| File | Tests |
|---|---|
| `auditor-schema.test.ts` | 13 |
| `auditor-controls.test.ts` | 21 |
| `auditor-risk.test.ts` | 12 |
| `auditor-evidence.test.ts` | 11 |
| `auditor-engine-smoke.test.ts` | 2 |
| `auditor-engine.test.ts` | 17 |
| `auditor-report-smoke.test.ts` | 1 |
| `auditor-package.test.ts` | 10 |
| `auditor-http.test.ts` | 13 |
| `auditor-abuse-cases.test.ts` | 17 |
| `auditor-adapters.test.ts` | 3 |
| **Total** | **120** |

406 + 120 = 526, matching the Node test runner's reported total exactly in both consecutive
`npm run check` runs — no estimation.

## Demo

```bash
npm run demo:auditor:v01
```

Ran all five required flows (A: healthy deployment, B: missing Sentinel under the high-risk profile,
C: corrupt Ledger, D: containment uncertainty, E: tampered package) against real Ledger-backed
evidence, printed every required marker line, exited 0.

## Failing-first defects found

Genuine defects caught by actually running the suite against realistic, real-Ledger-shaped evidence —
not assumed correct from inspection alone (the same discipline this project's other volumes follow):

1. **`LedgerEvidenceProvider`'s agent-scoping used only `getEventsByActor`.** The accepted
   `GateLedgerAdapter` records almost every Gate event's `actor` as the *system component* that
   acted (`{type:'SYSTEM', id:'tna-gate'}`), not the governed agent. An agent-scoped evidence pull
   built only on `getEventsByActor` returned **zero events** against a realistic fixture built from
   the actual adapter's event shape (`tests/auditor/auditor-evidence.test.ts` failed with
   `actual: []` before this was found). Root cause: Gate's own agent-stream convention
   (`agent:<agentId>`) was the correct primary query, not actor matching. Fixed by pulling from the
   agent stream, the actor index (still useful — capability redemption's actor genuinely is the
   agent), and a decision-id bridge (`getEventsByDecision`) to reach cross-subsystem evidence (e.g.
   Sentinel's own stream) correlated to the same Gate decision. Documented as a permanent design note
   in `auditor-evidence-model-v0.1.md`, not silently patched.
2. **`TNA-IDENT-001` required `authority_context.agent_id` on `EXECUTION_STARTED`.** The accepted
   `GateLedgerAdapter.executionStarted()` never sets `authority_context` at all on that event type —
   a fully realistic "healthy deployment" fixture therefore FAILed this control on every run, not
   because identity was actually unbound, but because the control checked a field the accepted
   implementation structurally never populates there. Caught by the engine-level "healthy fixture"
   smoke test observing an unexpected FAIL. Fixed by excluding `EXECUTION_STARTED` from this
   control's binding requirement (execution-level identity assurance comes from `TNA-EXEC-001`'s
   capability-correlation check instead) — the AGENT_REGISTERED registration-matching logic had the
   same class of bug (checking `actor.id` instead of `authority_context.agent_id`) and was fixed the
   same way.
3. **The seeded baseline manifest omitted `TNA-RUNTIME-002`/`TNA-RUNTIME-003` claims.** Sentinel v0.1
   genuinely implements all twenty rule types including `POLICY_CHANGED` and
   `TOOL_NOT_ALLOWED`/`RESOURCE_NOT_ALLOWED` (its own accepted proof-of-work states this explicitly),
   but the initial `buildAcceptedBaselineManifest()` never cited that fact for these two controls,
   so a fully-evidenced healthy fixture fell short of `PASS_WITH_FINDINGS`
   (`TNA-RUNTIME-002`/`003` both `INSUFFICIENT_EVIDENCE` with reason `No manifest claim references
   ...`). Same smoke test caught it directly. Fixed by adding both claims, each citing the actual
   Sentinel test that substantiates the rule's existence.
4. **Ledger's own event-completeness invariants were stricter than the first-draft test/demo
   fixtures assumed** (`AUTHORIZATION_ALLOWED` requires `{decision_id, agent_id, policy_hash,
   action}`; `CAPABILITY_ISSUED` requires `{capability_id, decision_id, authority_expiry}`;
   `CAPABILITY_REDEEMED` orphan-checks against a prior `CAPABILITY_ISSUED`; `ATOM_ACCEPTED` requires
   `spec_context.{verifier_verdict, human_decision}` and `artifact_context.artifact_hash`, plus a
   prior `ATOM_VERIFICATION_ACCEPTED`/`ATOM_HUMAN_DECISION`). Several `auditor-evidence.test.ts` and
   demo-script events failed to insert on first run with `LedgerError: INVALID_EVENT`/`ORPHAN_EVENT`.
   Fixed by completing every event to satisfy the real, already-accepted Ledger invariants — a
   test-fixture defect, not an Auditor implementation defect, but caught the same way: by running
   against the real dependency rather than a simplified stand-in.

All four were root-caused by comparing expected vs. actual output from real execution, not by
inspection or assumption.

## Meta-evidence

526 passing tests establish that the implemented behaviors pass their own checks. As with the
accepted Sentinel milestone, this does not by itself certify every Volume 7 requirement to the letter
— v0.1 targets the accountability-critical subset (deterministic evaluation, no-evidence-≠-pass,
critical-failure floor, atomic finalization, runtime-owned run numbering, concurrency safety, tenant
isolation, package tamper-detection, and honest regulatory-boundary framing) rather than every
numbered item verbatim. The requirement matrix is the honest accounting of what is and is not
covered.

## Trust-closure pass (post-acceptance architectural review)

After the 526-test suite above went green and the demo's 5 flows passed, an architectural review —
same discipline as the Sentinel concurrency closure (TNA-33/34) — found two trust-boundary gaps that
no individual test had caught: corrupt Ledger evidence could still satisfy *dependent* controls whose
evaluator hadn't independently thought to check stream integrity, and a hash-valid-but-forged
implementation manifest could satisfy a control claim as if it were the genuine accepted baseline.
Full root-cause/fix detail is in `docs/auditor/auditor-v0.1-trust-closure.md`. This section records
the resulting re-verification; the 526-test result above is preserved unmodified as the historical
record of what the *original* v0.1 suite proved.

### Command

```bash
npm run check   # typecheck && lint && build+test
```

Run twice consecutively, no manual cleanup between runs.

### Observed output — Run 1 (post-closure)

- Typecheck: PASS
- Lint: PASS
- Build: PASS
- Total tests: 535
- Passed: 535
- Failed: 0

### Observed output — Run 2 (immediately after, no cleanup)

- Total tests: 535
- Passed: 535
- Failed: 0

### Reconciliation

526 (original v0.1 baseline, unchanged and unweakened) + 9 new trust-closure tests = 535, matching the
Node test runner's reported total exactly in both consecutive runs:

| File | New tests | What they prove |
|---|---|---|
| `auditor-engine.test.ts` | 2 | a caller-declared `trust_class: BUILT_IN_ACCEPTED_BASELINE` is rejected by `setManifest`; the built-in manifest is always `BUILT_IN_ACCEPTED_BASELINE` and is never affected by `setManifest` |
| `auditor-controls.test.ts` | 4 | corrupt VAD evidence blocks `TNA-VER-001`; corrupt Sentinel evidence mixed with valid Gate evidence blocks `TNA-RUNTIME-001` (also the "mixed valid+invalid evidence" case); an irrelevant corrupt stream elsewhere in the bundle does not poison `TNA-AUTH-001`; an admin-installed, hash-valid manifest fabricating a claim cannot satisfy `TNA-EVID-001` |
| `auditor-package.test.ts` | 3 | the exported package exposes `integrity_qualification`/`manifest_trust_summary`; tampering either after export breaks `verifyAuditPackage` |

Pre-existing tests already covered part of this ground before the closure pass began (corrupt-Gate-
evidence → explicit `INSUFFICIENT_EVIDENCE`, `TNA-INTEG-001` FAIL on corruption) — those are listed in
the reconciliation table above as part of the original 526, not double-counted here.

### Demo (post-closure)

```bash
npm run demo:auditor:v01
```

All five flows remain green against real Ledger-backed evidence. Flow C (corrupt Ledger) now asserts,
in addition to `TNA-INTEG-001 == FAIL`, that a *dependent* control (`TNA-AUTH-001`) resolves to the
explicit `INSUFFICIENT_EVIDENCE` state — not merely `!= PASS` — demonstrating Finding 1's fix
end-to-end. Flow D's mechanism was redesigned: it previously forced `TNA-CONTAIN-001` to fail by
temporarily installing a manifest missing that control's claim, a mechanism the trust-closure pass
makes structurally impossible (admin-installed manifests never reach evaluation at all — see Finding
2). Flow D now demonstrates the same "containment truthfulness" property with real evidence alone: a
fabricated `SENTINEL_TERMINATED` report over `containment_status: CONTAINMENT_UNCONFIRMED` FAILs
`TNA-CONTAIN-001` directly, which is in fact closer to the control's actual intent (TNA-33/38: never
fabricate confirmed containment) than the old manifest-swap mechanism was.

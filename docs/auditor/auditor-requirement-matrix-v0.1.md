# TNA Auditor v0.1 Requirement Matrix

Scored against the section-142 acceptance gate. Every item is IMPLEMENTED and TESTED unless noted.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | All existing 406 tests remain green | IMPLEMENTED, TESTED | 526/526 total at original v0.1 acceptance, two consecutive `npm run check` runs; 535/535 (526 + 9 trust-closure tests) after the trust-closure pass, two further consecutive `npm run check` runs — see `auditor-verification-v0.1.md` |
| 2 | AssessmentSpec v1 exists | IMPLEMENTED, TESTED | `auditor-schema/src/index.ts`; `auditor-schema.test.ts` |
| 3 | Explicit scope exists | IMPLEMENTED, TESTED | `validateAssessmentScope`; ambiguous-scope rejection tested |
| 4 | Evidence cutoff exists | IMPLEMENTED, TESTED | `evidence_cutoff_at` bound and enforced; cutoff-race test |
| 5 | Control catalog version binding exists | IMPLEMENTED, TESTED | `CONTROL_CATALOG_VERSION` pinned per run; replay mismatch test |
| 6 | Control catalog exists | IMPLEMENTED, TESTED | 27 controls, all 17 categories covered |
| 7 | Meaningful baseline controls exist | IMPLEMENTED, TESTED | see `tna-control-catalog-v0.1.md` |
| 8 | Control evaluation deterministic | IMPLEMENTED, TESTED | replayability test; no I/O in any evaluator |
| 9 | PASS/PARTIAL/FAIL/NA/INSUFFICIENT/ERROR implemented | IMPLEMENTED, TESTED | all six states exercised across the suite |
| 10 | No-evidence cannot become PASS | IMPLEMENTED, TESTED | every INSUFFICIENT_EVIDENCE-path test |
| 11 | Stale evidence handled explicitly | IMPLEMENTED, TESTED | `TNA-CAP-003` 24h freshness test |
| 12 | Corrupt evidence cannot support PASS | IMPLEMENTED, TESTED | `TNA-INTEG-001` FAILs on corruption; every other control routed through the central `qualifyEvidenceIntegrity` gate (trust-closure pass, Finding 1) downgrades to `INSUFFICIENT_EVIDENCE`; demo Flow C, plus dedicated Gate/VAD/Sentinel/mixed/irrelevant-stream tests — see item 59 |
| 13 | Self-attestation cannot satisfy trusted evidence requirements | IMPLEMENTED (by construction) | `EVIDENCE_SOURCE_TRUST` enum; no code path grants trust from caller input |
| 14 | Ledger evidence provider exists | IMPLEMENTED, TESTED | `LedgerEvidenceProvider`; real-Ledger integration tests |
| 15 | Accepted implementation manifest exists | IMPLEMENTED, TESTED | `buildAcceptedBaselineManifest`; 15 claims across 6 milestones |
| 16 | Manifest hash verified | IMPLEMENTED, TESTED | `verifyManifestIntegrity`; forged-manifest rejection test. Trust-closure pass (Finding 2) clarified that hash integrity alone was never sufficient for trust — see item 60 |
| 17 | Gate controls evaluated | IMPLEMENTED, TESTED | IDENT/AUTH/APPR/CAP/EXEC/ISO/SEC/EGR (13 controls) |
| 18 | VAD controls evaluated | IMPLEMENTED, TESTED | VER-001, VER-002, EXEC-002 |
| 19 | Ledger controls evaluated | IMPLEMENTED, TESTED | EVID-001, INTEG-001, TEN-001 |
| 20 | Sentinel controls evaluated | IMPLEMENTED, TESTED | RUNTIME-001..005, CONTAIN-001/002, REVOKE-001, RECOV-001 (9 controls) |
| 21 | Risk scoring deterministic | IMPLEMENTED, TESTED | `auditor-risk.test.ts` |
| 22 | Critical failure cannot be averaged away | IMPLEMENTED, TESTED | critical-floor test (25 passes + 1 CRITICAL FAIL → score 100) |
| 23 | Coverage calculation correct | IMPLEMENTED, TESTED | coverage test, NOT_APPLICABLE exclusion |
| 24 | Overall assessment outcome deterministic | IMPLEMENTED, TESTED | full outcome-logic test matrix |
| 25 | Findings generated | IMPLEMENTED, TESTED | one per non-PASS/non-NA result; ordering test |
| 26 | Remediation guidance deterministic | IMPLEMENTED, TESTED | static per-control text, attached test |
| 27 | Assessment finalization atomic | IMPLEMENTED, TESTED | one transaction for results+findings+risk+hash+status |
| 28 | Runtime-owned run numbering | IMPLEMENTED, TESTED | CAS-protected `claimRun`; monotonic-numbering test |
| 29 | Concurrent duplicate runs safe | IMPLEMENTED, TESTED | one winner, one CONFLICT, proven with real `Promise.allSettled` |
| 30 | Concurrency tested | IMPLEMENTED, TESTED | 20 concurrent control evaluations, no duplicate/lost results |
| 31 | Restart persistence/recovery tested | IMPLEMENTED, TESTED | store reopen test; interrupted-run → INDETERMINATE test |
| 32 | Tenant isolation enforced | IMPLEMENTED, TESTED | every query `(tenant_id,...)`-scoped |
| 33 | Cross-tenant evidence blocked | IMPLEMENTED, TESTED | scoped-collection test; cross-tenant read/run/replay rejection |
| 34 | Reports bounded | IMPLEMENTED, TESTED | `MAX_REPORT_BYTES`/`MAX_EXPORT_BYTES` |
| 35 | List endpoints paginated | IMPLEMENTED, TESTED | cursor pagination, both facade and HTTP |
| 36 | Secrets not exposed | IMPLEMENTED, TESTED | schema-level rejection + report-level scan test |
| 37 | SQL injection protected | IMPLEMENTED (by construction) | 100% parameterized queries throughout `AuditorRuntime` |
| 38 | Export path safety | NOT APPLICABLE (v0.1 scope) | packages/reports are in-memory values over HTTP/API, never written to caller-influenced disk paths — see threat model #20 |
| 39 | JSON audit package exists | IMPLEMENTED, TESTED | `buildAuditPackage` |
| 40 | Package verification exists | IMPLEMENTED, TESTED | `verifyAuditPackage` |
| 41 | Tamper detected | IMPLEMENTED, TESTED | 3 independent tamper vectors tested; demo Flow E |
| 42 | Markdown report exists | IMPLEMENTED, TESTED | `buildMarkdownReport`; content assertions |
| 43 | Authenticated HTTP API exists | IMPLEMENTED, TESTED | bearer auth, reader/runner/admin roles |
| 44 | Real HTTP integration suite exists | IMPLEMENTED, TESTED | 13 tests, real TCP server + `fetch`, not facade-only |
| 45 | Auditor activity evidenced in Ledger | IMPLEMENTED, TESTED | `AuditorLedgerAdapter`; real-Ledger chain/verify test |
| 46 | Healthy demo works | IMPLEMENTED, TESTED | Flow A |
| 47 | Missing-Sentinel demo works | IMPLEMENTED, TESTED | Flow B |
| 48 | Corrupt-Ledger demo works | IMPLEMENTED, TESTED | Flow C |
| 49 | Containment-uncertainty demo works | IMPLEMENTED, TESTED | Flow D |
| 50 | Tampered-package demo works | IMPLEMENTED, TESTED | Flow E |
| 51 | Check passes twice | IMPLEMENTED, TESTED | two consecutive clean `npm run check` runs |
| 52 | Threat model complete | IMPLEMENTED | `auditor-threat-model-v0.1.md`, 25 categories |
| 53 | Control catalog documented | IMPLEMENTED | `tna-control-catalog-v0.1.md` |
| 54 | Requirement matrix complete | IMPLEMENTED | this document |
| 55 | Proof of work complete | IMPLEMENTED | `proof-of-work-auditor-v0.1.md` |
| 56 | No frontend | CONFIRMED | none built |
| 57 | No external compliance certification claims | CONFIRMED | `AUDITOR_LIMITATIONS` verbatim on every package/report |
| 58 | No unrelated feature expansion | CONFIRMED | scope limited to sections 1-148 of the Volume 7 brief |
| 59 | Evidence-integrity qualification is architectural, not per-evaluator | IMPLEMENTED, TESTED | central `qualifyEvidenceIntegrity` gate inside `evaluateControl`; dedicated tests for corrupt Gate (`TNA-AUTH-001`), corrupt VAD (`TNA-VER-001`), corrupt Sentinel mixed with valid Gate evidence (`TNA-RUNTIME-001`), and an irrelevant-corrupt-stream-does-not-poison case — see `auditor-v0.1-trust-closure.md` Finding 1 |
| 60 | Manifest authenticity is separated from manifest integrity | IMPLEMENTED, TESTED | `trust_class: ManifestTrustClass`; only `BUILT_IN_ACCEPTED_BASELINE` (one compiled code path, pinned to the six accepted anchors) satisfies a claim automatically; admin-installed manifests are always `ADMIN_PROVIDED`, never wired into evaluation, and cannot satisfy a claim even with a perfectly correct self-computed hash — see `auditor-v0.1-trust-closure.md` Finding 2 |
| 61 | Caller cannot elevate declared trust classification | IMPLEMENTED, TESTED | `setManifest` rejects (`MANIFEST_INVALID`) any manifest whose `trust_class` isn't `ADMIN_PROVIDED` — a caller-declared `BUILT_IN_ACCEPTED_BASELINE` is rejected outright, never installed |
| 62 | Trust metadata bound into the assessment hash and exposed in the export | IMPLEMENTED, TESTED | `computeAssessmentHash` hashes `manifest_trust_class` and every evidence ref's `integrity_qualification`; the exported package carries `manifest_trust_summary` and per-ref `integrity_qualification`; tampering either breaks `verifyAuditPackage` |

## Known partial / explicitly out of scope

- **Export path safety (#38)**: not applicable in v0.1 — no file-path-shaped API exists yet. Will need
  its own control if/when a disk-export feature is added.
- **Maturity score (section 34)**: deliberately not implemented — risk + coverage only, per the
  brief's own recommendation.
- **Regulatory mapping (section 94)**: deliberately not implemented, even as an empty/informational
  structure — avoids any appearance of certification scope creep.
- **Per-control `AUDIT_CONTROL_EVALUATED` Ledger events (section 115's "likely events" list)**:
  deliberately not emitted (documented volume-proportionality decision, see
  `auditor-ledger-integration-v0.1.md`) — assessment-level lifecycle events and per-finding events are
  emitted instead.
- **Live queries into Gate/Sentinel/VAD's own runtime APIs**: v0.1 relies exclusively on Ledger as the
  live evidence source, supplemented by the static implementation-evidence manifest — documented
  explicitly in `auditor-overview-v0.1.md` and `auditor-evidence-model-v0.1.md`, not a silent gap.

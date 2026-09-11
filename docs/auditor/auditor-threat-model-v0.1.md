# TNA Auditor v0.1 Threat Model

Status per category: MITIGATED, PARTIALLY MITIGATED, or NOT MITIGATED (explicit, by design or by
scope). "Mitigated" means a deterministic control exists and is tested — not that the category is
impossible.

| # | Threat | Status | Detail |
|---|---|---|---|
| 1 | Evidence forgery (fake Ledger event) | PARTIALLY MITIGATED | evidence is only ever read through a tenant-scoped Ledger reader over the real `Ledger` facade — nothing in Auditor accepts a caller-supplied event as if Ledger produced it; forging evidence still requires compromising Ledger's own writer-identity model, which is Ledger's (not Auditor's) boundary |
| 2 | Self-attestation treated as trusted evidence | MITIGATED | `EVIDENCE_SOURCE_TRUST` is a controlled enum; no code path in this milestone constructs an `OPERATOR_ASSERTION`/`UNTRUSTED_SELF_REPORT` ref and has it satisfy a control |
| 3 | Evidence omission | MITIGATED (by design, honestly reported) | absence of evidence resolves to `INSUFFICIENT_EVIDENCE`, never `PASS` — proven across every control class (abuse-case suite) |
| 4 | Evidence staleness | MITIGATED | `TNA-CAP-003`'s 24h freshness window (`isFresh`); stale enforcement proof downgrades PASS to PARTIAL rather than silently counting as current |
| 5 | Evidence corruption | MITIGATED | `TNA-INTEG-001` FAILs on any `verifyStream`-invalid stream; every other control's result is passed through the central `qualifyEvidenceIntegrity` gate (trust-closure pass, Finding 1, TNA-41), which downgrades any PASS/PARTIAL citing `INVALID`/`UNVERIFIED`/`UNAVAILABLE` evidence to `INSUFFICIENT_EVIDENCE` — architectural, not per-evaluator (superseding the original per-control convention noted in the pre-closure version of this row) |
| 6 | Cross-tenant evidence leakage | MITIGATED | every query is `(tenant_id, ...)`-scoped throughout `AuditorRuntime`; a cross-tenant caller naming a real assessment id gets `NOT_FOUND`, not a usable handle |
| 7 | Control-catalog tampering | MITIGATED (by construction) | the catalog is compiled TypeScript, not caller-supplied data; `CONTROL_CATALOG_VERSION` is pinned per run and a mismatch on replay is surfaced explicitly, never silently re-interpreted |
| 8 | Control-definition tampering via API | MITIGATED (no such API exists) | there is no endpoint or method that accepts a `Control` definition from a caller |
| 9 | Risk-score manipulation | MITIGATED | `overall_risk_score`/`risk_contribution` are pure functions of `(criticality, status)`, computed centrally; no caller input reaches them |
| 10 | Assessment-result mutation | MITIGATED | no `markControlPass`-shaped API exists (section 119); results are written only by `runAssessment`/`replayAssessment`'s atomic finalization |
| 11 | Duplicate/concurrent run | MITIGATED | CAS-protected run claim (`state_version`), same discipline TNA-33 established for Sentinel — proven with genuinely concurrent `runAssessment` calls |
| 12 | Stale assessment silently re-evaluated as current | MITIGATED | replay pins and compares `control_catalog_version`; a mismatch is exposed on the `RunRecord`, not hidden |
| 13 | Partial finalization | MITIGATED | control results + findings + risk summary + evidence manifest + assessment_hash are all persisted in one transaction; evidence-collection or evaluation failure resolves the run to `INDETERMINATE`/`FAILED`, never a fabricated `COMPLETED` |
| 14 | Evaluator error laundered into PASS | MITIGATED | caught at the `evaluateControl` boundary, resolves to `ERROR` with `risk_contribution` equal to `FAIL`'s — never treated as safer |
| 15 | Implementation-manifest forgery | MITIGATED | `verifyManifestIntegrity` recomputes the manifest's own hash; only `admin` can install a supplementary manifest at all, and only as `ADMIN_PROVIDED`; a hash-tampered manifest fails integrity and cannot satisfy any control. Note: this row originally implied hash integrity alone was sufficient — see rows 27-29 for the authenticity gap the trust-closure pass found and closed |
| 16 | Secret leakage (in spec, evidence, or report) | MITIGATED (fixed rule set) | same secret-shaped-field/bearer-value detector as the accepted Ledger/Sentinel — not general DLP |
| 17 | Report tampering | N/A (reports are derived, not authoritative) | the Markdown report is generated fresh from a verified package each time; tampering the *package* is what `verifyAuditPackage` exists to catch |
| 18 | Package tampering | MITIGATED | `verifyAuditPackage` recomputes `assessment_hash` from the package's own declared content; any control-result/risk/evidence-manifest change is detected |
| 19 | SQL injection | MITIGATED | every query is parameterized (`?` placeholders) throughout `AuditorRuntime`; no string concatenation into SQL anywhere |
| 20 | Path traversal (report/export writing) | N/A (v0.1 scope) | v0.1 returns packages/reports as in-memory values over HTTP/API, not files written to caller-influenced paths; no filename derived from caller input is ever used for disk I/O |
| 21 | Denial of service (unbounded queries/collection) | MITIGATED | `MAX_COLLECTED_EVENTS`, `MAX_PAGES_PER_QUERY`, runtime-owned collection timeout, `MAX_QUERY_PAGE_SIZE`/`MAX_FINDINGS_PER_RESPONSE`, `MAX_EXPORT_BYTES`/`MAX_REPORT_BYTES`, `MAX_BODY_BYTES` on the HTTP surface |
| 22 | Compromised Auditor process | NOT MITIGATED (by design) | if the Auditor process itself is compromised, its own conclusions cannot be trusted; no control in this milestone claims otherwise |
| 23 | Compromised host | NOT MITIGATED (by design) | identical posture to the accepted Gate/Ledger/Sentinel milestones — see their own threat models |
| 24 | Privileged database rewrite | NOT MITIGATED (by design) | identical posture to the accepted Ledger — a party with direct SQLite file access can rewrite Auditor's own store; this is exactly the scenario `TNA-INTEG-001` exists to catch *for the evidence Auditor consumes*, not for Auditor's own storage (out of scope for an application-level control, same as Ledger) |
| 25 | False compliance claims | MITIGATED (by construction) | no code path in this milestone emits an ISO 27001/SOC 2/NIST/EU AI Act/DORA/HIPAA/GDPR/NIS2/PCI DSS status; `AUDITOR_LIMITATIONS` is attached to every package/report verbatim |
| 26 | Corrupt evidence reused by a dependent control | MITIGATED (trust-closure pass, Finding 1) | previously only `TNA-INTEG-001`/`TNA-AUTH-001` checked stream integrity; any other control citing a corrupt stream's events could still PASS. The central `qualifyEvidenceIntegrity` gate now downgrades every affected PASS/PARTIAL to `INSUFFICIENT_EVIDENCE`, proven for a Gate control (`TNA-AUTH-001`), a VAD control (`TNA-VER-001`), and a mixed-evidence Sentinel/Gate control (`TNA-RUNTIME-001`) |
| 27 | Valid hash over a forged manifest | MITIGATED (trust-closure pass, Finding 2, TNA-42) | a manifest can be internally hash-consistent and still false — hash integrity was never sufficient on its own. `trust_class` now separates integrity from authenticity; only `BUILT_IN_ACCEPTED_BASELINE` (reachable through exactly one compiled code path, bound to the six pinned accepted anchors) can satisfy a claim automatically |
| 28 | Privileged admin false implementation assertion | MITIGATED (trust-closure pass, Finding 2) | an admin installing a manifest that fabricates a nonexistent protection — even with a perfectly correct self-computed hash — cannot satisfy a control: `setManifest`-installed manifests are always `ADMIN_PROVIDED`, never wired into `EvaluationContext.manifest`, and `manifestClaims()` requires `manifestAuthentic` (`trust_class === 'BUILT_IN_ACCEPTED_BASELINE'`) in addition to `manifestValid` before any claim counts |
| 29 | Evidence/manifest trust-class escalation | MITIGATED (trust-closure pass) | a caller cannot request `trust_classification=BUILT_IN_ACCEPTED_BASELINE` through `setManifest` (rejected with `MANIFEST_INVALID`); an evidence stream's `qualification` is computed once at collection time from `Ledger.verifyStream`, never caller-settable. Both dimensions are bound into `computeAssessmentHash`, so replay cannot silently reclassify `UNVERIFIED → VALID` or `ADMIN_PROVIDED → TRUSTED` either |
| 30 | Audit package trust-metadata tampering | MITIGATED (trust-closure pass) | `manifest_trust_class` and every ref's `integrity_qualification` are hashed inputs to `computeAssessmentHash`; tampering either in an exported package after the fact breaks `verifyAuditPackage` (`ASSESSMENT_HASH_MISMATCH`), proven directly |

## Compromised host / compromised process limitations

Identical in kind to the limitations already documented for Gate, Ledger, and Sentinel: an Auditor
process running on a compromised host, or itself compromised, cannot be assumed to produce trustworthy
conclusions. This is not claimed otherwise anywhere in this milestone.

## Observability limitation

Auditor can only evaluate evidence that reaches it. An action taken through a path that never
produces a Ledger event — or a subsystem never wired to write into Ledger at all — is invisible to
every control that depends on that evidence, and resolves to `INSUFFICIENT_EVIDENCE`, never a
fabricated pass (**MISSING_EVENT ≠ SAFE_EVENT**, TNA-28/29, inherited unchanged from Sentinel's own
principle and restated here as TNA-35: "missing evidence is a first-class result").

## Regulatory / certification boundary (sections 94, 130)

TNA Auditor evaluates configured controls against available evidence. **It does not certify legal,
regulatory, contractual, or industry compliance.** This statement appears verbatim in every exported
audit package and Markdown report footer, in the overview doc, and in this threat model. Section 94's
future-facing external-framework mapping structure (`external_reference`, `mapping_type`, `notes`) is
explicitly **not implemented** in v0.1 — there is no regulatory mapping data anywhere in this
milestone, informative or otherwise, to avoid even an unintentional appearance of certification
scope creep.

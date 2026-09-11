# TNA Auditor Audit Package Model v0.1

## Structure (section 43)

```ts
interface AuditPackage {
  manifest: { package_version: '1.0'; generated_at: string };
  assessment: AssessmentRecord;
  run: RunRecord;
  evidence_manifest: readonly EvidenceRef[];   // every EvidenceRef for every collected event in this run
  control_results: readonly ControlResult[];
  findings: readonly AuditFinding[];
  risk_summary: RiskSummary;
  limitations: readonly string[];              // AUDITOR_LIMITATIONS, verbatim, every time
  assessment_hash: string;                      // the completion-time hash — see auditor-assessment-spec-v1.md
  manifest_trust_summary: { manifest_id: string; manifest_hash: string; trust_class: ManifestTrustClass };
}
```

`manifest_trust_summary` was added by the trust-closure pass (see `auditor-v0.1-trust-closure.md`,
Finding 2): it exposes the trust classification of the implementation-evidence manifest this run's
evaluation actually consulted (always `BUILT_IN_ACCEPTED_BASELINE` in v0.1) so a reviewer can see
directly why manifest-backed control claims were allowed to count, without cross-referencing anything
else. Every `evidence_manifest` entry also now carries `integrity_qualification` — see Evidence
reference model below.

`buildAuditPackage(runtime, principal, assessmentId, runNumber?)` reads exclusively through the
runtime's own principal-gated accessors (`getAssessment`, `getRun`, `listControlResults`,
`listFindings`, `getEvidenceBundle`) — export carries exactly the same tenant-isolation and
role-authorization guarantees as any other read; there is no separate, less-guarded export path.
Only a `COMPLETED` run with a finalized `risk_summary`/`assessment_hash` can be exported —
`buildAuditPackage` throws `INVALID_TRANSITION` otherwise (proven for both "no run yet" (`NOT_FOUND`)
and "run exists but is INDETERMINATE" (`INVALID_TRANSITION`)).

`MAX_EXPORT_BYTES` (8 MiB) bounds the serialized package; exceeding it throws `PAYLOAD_TOO_LARGE`
rather than silently truncating.

## Mandatory limitations (sections 130-132)

Every package carries `AUDITOR_LIMITATIONS` verbatim — the exact three sentences: no certification
claim (naming every framework this milestone explicitly does not claim), evidence-quality-bounded
conclusions, and the "unobserved systems return INSUFFICIENT_EVIDENCE, not fabricated assurance"
statement. Proven directly that every exported package includes all three, unmodified.

## Verification (sections 44-45)

`verifyAuditPackage(pkg: unknown): { valid: boolean; reason?: string }` — fully self-contained, needs
no store access, no principal, nothing but the package's own bytes:

1. **Schema check** — the object has the expected top-level shape (`isPlainAuditPackage`).
2. **Assessment-hash recomputation** — `computeAssessmentHash(spec_hash, control_profile_id,
   control_catalog_version, evidence_cutoff_at, evidence_manifest, control_results, risk_summary,
   manifest_trust_summary.trust_class)` is recomputed from the package's *own declared content* and
   compared against `assessment_hash`. Any change to any control result, the risk summary, the
   evidence manifest (including a single ref's `integrity_qualification`), the manifest trust
   classification, or any of the pinned spec/catalog fields changes the recomputed hash and fails
   verification (`ASSESSMENT_HASH_MISMATCH`) — this is the actual tamper-detection mechanism, not a
   separate signature scheme. The trust-closure pass added `manifest_trust_class` as a hashed input
   specifically so replay can never silently reclassify `ADMIN_PROVIDED → BUILT_IN_ACCEPTED_BASELINE`
   after the fact (Finding 2), and `integrity_qualification` was always part of each ref, so
   reclassifying `UNVERIFIED → VALID` on export is caught the same way (Finding 1).
3. **Finding-reference consistency** — every finding's `control_id` must appear among the package's
   own `control_results` (`FINDING_REFERENCES_UNKNOWN_CONTROL` otherwise).
4. **Evidence-reference consistency** — every `LEDGER_EVENT`-typed evidence ref cited by any control
   result must appear in the package's own `evidence_manifest`
   (`EVIDENCE_REF_NOT_IN_MANIFEST` otherwise).

## Tamper test (section 45)

Exported a healthy assessment, flipped one `control_results[i].status` from `FAIL` to `PASS` in the
raw JSON, re-verified: `valid: false`, `reason: 'ASSESSMENT_HASH_MISMATCH'`. Proven directly
(`tests/auditor/auditor-package.test.ts`) and reproduced in the demo's Flow E, which prints the exact
before/after status and the verification failure reason.

Also proven: tampering `risk_summary.overall_risk_score` alone (without touching any control result)
independently breaks verification, and injecting a finding that references a nonexistent control_id
is caught by the reference-consistency check even in the (contrived) case where the hash happened to
still match.

Trust-closure pass, Findings 1 & 2: also proven, tampering a single `evidence_manifest[i]
.integrity_qualification` (e.g. `UNVERIFIED` → `VALID`) after export breaks verification, and
tampering `manifest_trust_summary.trust_class` (e.g. escalating `ADMIN_PROVIDED` →
`VERIFIED_EXTERNAL`) after export independently breaks verification too
(`tests/auditor/auditor-package.test.ts`).

## Evidence reference model (section 46)

```ts
interface EvidenceRef {
  source_type: 'LEDGER_EVENT' | 'LEDGER_STREAM_INTEGRITY' | 'CONFIGURATION_SNAPSHOT' | 'IMPLEMENTATION_MANIFEST';
  source_trust: EvidenceSourceTrust;
  event_id?, stream_id?, sequence?, event_hash?, tenant_id?, observed_at?;   // Ledger evidence
  snapshot_id?, snapshot_hash?;                                              // configuration snapshots
  manifest_id?, manifest_hash?;                                              // implementation manifest
  integrity_qualification?: EvidenceQualification;                          // trust-closure pass, Finding 1
  manifest_trust_class?: ManifestTrustClass;                                 // trust-closure pass, Finding 2
}
```

Enough to identify one piece of evidence immutably regardless of its source type — for Ledger
evidence specifically, `event_id` + `event_hash` + `sequence` + `stream_id` + `tenant_id` together
make the reference independently re-verifiable against Ledger itself, not merely a free-text pointer.

`integrity_qualification` (stamped by `eventRef()` for every `LEDGER_EVENT`-typed ref, from the same
`stream_integrity` map the collecting bundle carries) and `manifest_trust_class` (stamped by
`manifestRef()` for every `IMPLEMENTATION_MANIFEST`-typed ref) let a reviewer see, per piece of cited
evidence, exactly why it was or wasn't allowed to support a control result — see
`auditor-evidence-model-v0.1.md` and `auditor-v0.1-trust-closure.md`.

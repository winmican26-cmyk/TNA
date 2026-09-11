# TNA Auditor Finding Model v0.1

## Model (section 29)

```ts
interface AuditFinding {
  finding_id: string;        // runtime-assigned (randomUUID)
  assessment_id: string;
  control_id: string;
  severity: Severity;        // the control's *effective* criticality at evaluation time (profile-aware)
  status: FindingStatus;     // v0.1 only ever creates OPEN (section 30)
  title: string; description: string;
  evidence_refs: readonly EvidenceRef[];
  reason_codes: readonly ReasonCode[];
  remediation: readonly string[];
  created_at: string;
}
```

`FINDING_STATUSES = OPEN | ACCEPTED_RISK | REMEDIATED | FALSE_POSITIVE | NOT_APPLICABLE` — the full
enum exists so the field is forward-compatible, but v0.1 deliberately does not build the workflow to
transition a finding out of `OPEN` (section 30, 120-121: no full finding-management workflow, and
certainly no API to rewrite a control's own FAIL into a PASS because a risk was accepted — see
`auditor-threat-model-v0.1.md`'s TNA-37 entry).

## When a finding is created

`buildFindings` (in `auditor-engine`) creates exactly one finding per control result whose status is
**not** `PASS` and **not** `NOT_APPLICABLE` — i.e. one for every `FAIL`, `PARTIAL`,
`INSUFFICIENT_EVIDENCE`, and `ERROR` result. `title`/`description`/`evidence_refs`/`reason_codes` are
copied directly from the control result; `remediation` falls back to the control's own static
`remediation_guidance` if the result didn't attach anything more specific.

## Ordering

Findings are persisted and returned in `compareFindingPriority` order (see
`auditor-risk-model-v0.1.md`) — severity, then originating-control-status severity, then a stable
`finding_id` tiebreak. Proven directly against a real assessment run
(`tests/auditor/auditor-package.test.ts`, "findings in the exported package are deterministically
ordered").

## Remediation guidance (section 97)

Static, catalog-authored text per control (`Control.remediation_guidance`) — never AI-generated
prose. A finding either carries a result-specific remediation note or the control's general guidance;
either way it is fully deterministic given the control catalog.

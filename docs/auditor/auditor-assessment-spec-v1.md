# TNA Auditor Assessment Spec v1

## Fields (section 5)

```ts
interface AssessmentSpecInput {
  version: '1.0';
  tenant_id: string;
  name: string;
  description?: string;
  scope: AssessmentScope;
  control_profile_id: 'TNA_BASELINE_V01' | 'TNA_HIGH_RISK_V01';
  evidence_cutoff_at: string; // ISO-8601 UTC
}
interface AssessmentSpec extends AssessmentSpecInput {
  assessment_id: string;   // runtime-assigned (randomUUID)
  created_at: string;      // runtime clock
  created_by: string;      // the authenticated principal's id, never a body field
  spec_hash: string;       // runtime-computed, see "Two hashes" below
}
```

Caller-supplied hash fields are never accepted: `validateAssessmentSpecInput` builds a fresh,
allow-listed object from the input — any extraneous field (`risk_score`, `assessment_hash`,
`run_number`, `outcome`, `control_catalog_version`, ...) is silently dropped, not merely ignored.
Proven directly in `sentinel-abuse-cases`-style tests in `auditor-abuse-cases.test.ts`.

## Two hashes, not one

Section 5 lists `assessment_hash` as part of the spec's own fields ("the runtime computes
`assessment_hash`"); section 42-43 separately defines a comprehensive hash covering the *evaluated*
assessment (spec + catalog version + evidence cutoff + evidence reference manifest + control results
+ risk result). These are not the same computation, and treating them as one field would either make
the spec's own hash meaningless (computed before any evaluation exists) or make the section-42 hash
unavailable until artificially forced onto the spec object. This milestone resolves the tension
explicitly, as a documented boundary (the same discipline Sentinel used for its session/policy field
split):

- **`AssessmentSpec.spec_hash`** — computed immediately at creation (`computeSpecHash`), over exactly
  the caller-meaningful spec fields (`version, tenant_id, name, description?, scope,
  control_profile_id, evidence_cutoff_at`). Gives the spec object itself an immutable, tamper-evident
  identity from `CREATED` onward — analogous to Sentinel's `policy_hash`.
- **The completion-time `assessment_hash`** (sections 42-43) — computed once per run, at
  finalization, in `auditor-engine`'s `computeAssessmentHash`, over `spec_hash, control_profile_id,
  control_catalog_version, evidence_cutoff_at, evidence_manifest (sorted), control_results (sorted),
  risk_summary`. This is the hash that appears in `RunRecord.assessment_hash`, in the exported
  `AuditPackage.assessment_hash`, and is what `verifyAuditPackage` recomputes and compares (the
  actual tamper-detection mechanism, sections 44-45).

Both hashes exclude mutable presentation-only fields and are pure functions of their inputs
(`canonical()`/`hash()` from `auditor-schema`, same algorithm as the accepted Ledger/Sentinel).

## Assessment scope (section 6)

```ts
interface AssessmentScope {
  tenant_wide: boolean;           // explicit opt-in required if no agent/correlation filter given
  agent_ids?: readonly string[];
  correlation_ids?: readonly string[];
  tool_ids?: readonly string[];
  policy_ids?: readonly string[];
  time_range: { from: string; to: string };
  environment?: string;
}
```

`validateAssessmentScope` rejects an ambiguous scope outright: at least one of `agent_ids`/
`correlation_ids` must be non-empty, **or** `tenant_wide` must be explicitly `true`. It never defaults
silently to "everything." `time_range.to` may never exceed the assessment's own `evidence_cutoff_at`,
and `time_range.from` must be strictly before `time_range.to`.

## Evidence cutoff (sections 18, 107)

Every assessment binds `evidence_cutoff_at`. `LedgerEvidenceProvider` filters every collected event
by its runtime-assigned `received_at` — never a caller-supplied or event-declared timestamp — against
this cutoff, so evidence written to Ledger *after* the cutoff can never enter the assessment
regardless of when `collect()` actually runs (proven directly:
`tests/auditor/auditor-evidence.test.ts`, "evidence-after-cutoff race").

## Snapshot semantics (section 19, 39)

A completed run stores its full collected `EvidenceBundle` (`auditor_runs.evidence_bundle_json`).
`replayAssessment` re-evaluates against that *stored* bundle, never a fresh Ledger query — this is
what makes replay reproducible independent of what has happened to Ledger since. See
`auditor-evidence-model-v0.1.md` and `auditor-risk-model-v0.1.md` for what "reproducible" means when
the control catalog itself has since changed.

## Control profile version binding (sections 18, 40-41)

Each run pins `control_catalog_version` (`CONTROL_CATALOG_VERSION` from `auditor-controls`, currently
`1.0`) and `evaluator_version` (`EVALUATOR_VERSION`, currently `1.0`) at claim time. A replay compares
the *current* catalog version against the pinned one and surfaces `catalog_version_mismatch` on the
`RunRecord` explicitly — it never silently re-interprets historical results under newer rules.

# TNA Auditor Control Model v1

## Control (sections 7-8)

```ts
interface Control {
  control_id: string;       // stable, machine-readable, pattern TNA-XXXX-NNN
  version: string;
  title: string; description: string; objective: string;
  category: ControlCategory;      // one of the 17 fixed categories (section 8)
  criticality: Severity;          // INFO|LOW|MEDIUM|HIGH|CRITICAL — distinct from a finding's severity (section 37)
  applicable_profiles: readonly ControlProfileId[];
  required_evidence: readonly EvidenceRequirement[];
  evaluation_method: string;      // descriptive, not executable
  failure_conditions: readonly string[];
  remediation_guidance: readonly string[];
  dependencies?: readonly string[];
}
```

Categories (`CONTROL_CATEGORIES`, fixed, no arbitrary strings): `IDENTITY, AUTHORITY, APPROVAL,
CAPABILITY, EXECUTION, ISOLATION, SECRETS, EGRESS, VERIFICATION, EVIDENCE, INTEGRITY,
RUNTIME_DEFENSE, REVOCATION, CONTAINMENT, TENANT_ISOLATION, HUMAN_OVERSIGHT, RECOVERY`. Every category
is covered by at least one control (`tests/auditor/auditor-controls.test.ts`).

## Evaluator contract (section 24)

```ts
type ControlEvaluator = (control: Control, context: EvaluationContext, evidence: EvidenceBundle) => ControlResult;
```

Deterministic and side-effect-free: same control + same context + same evidence always produces the
same result (proven directly, "deterministic replayability" test). No LLM, no fuzzy scoring — every
evaluator is hand-written TypeScript pattern-matching over the collected `LedgerEvent[]` and, where a
control is inherently structural rather than per-execution, the implementation-evidence manifest.

## Dispatch and evaluator isolation (sections 101-102)

`evaluateControl(control, context, evidence)` looks up the registered evaluator and calls it inside a
try/catch. An evaluator that throws — on genuinely malformed input, never by design — resolves to a
first-class `ERROR` result (`reason_codes: ['EVALUATOR_ERROR']`) rather than crashing the assessment
or being silently dropped. `ERROR`'s `risk_contribution` equals the control's full criticality score,
same as `FAIL` — an error is never treated as safer than a failure (proven: "a malformed event that
causes the evaluator to throw resolves to ERROR, never PASS").

## Result-building helper

Every evaluator returns through one shared `finish(control, context, status, reasonCodes,
observations, limitations, evidenceRefs, remediation?)` helper (`auditor-controls/src/index.ts`),
which is the single place `risk_contribution` is computed
(`computeRiskContribution(effectiveCriticality(control, context), status)` — see
`auditor-risk-model-v0.1.md`). No evaluator decides its own risk contribution ad hoc.

## Manifest-backed structural controls

Several controls (isolation mediation, egress restriction, Ledger append-only surface, capability
single-use, tenant isolation, ...) are about a *component's own implementation*, not a per-execution
event Ledger would naturally emit. These route through the shared `evaluateManifestOnly` helper:
`INSUFFICIENT_EVIDENCE` if no manifest was supplied to the assessment, `FAIL` if the supplied manifest
fails its own hash-integrity check, `INSUFFICIENT_EVIDENCE` (`MANIFEST_NOT_AUTHENTIC`) if the manifest
is hash-valid but not `BUILT_IN_ACCEPTED_BASELINE`-classified (trust-closure pass, TNA-42 — see
`auditor-v0.1-trust-closure.md`), `INSUFFICIENT_EVIDENCE` if authentic but carries no claim for this
control, `PASS` (with `IMPLEMENTATION_MANIFEST_SATISFIED`) otherwise. See `auditor-evidence-model-v0.1.md`
for the manifest model itself.

## Evidence-integrity qualification gate (trust-closure pass, section 4-7)

Every non-`TNA-INTEG-001` evaluator's result is piped through `qualifyEvidenceIntegrity(control,
result, context)` inside `evaluateControl()` before it is returned. A `PASS`/`PARTIAL` result that
cites a `LEDGER_EVENT`-typed evidence ref whose `integrity_qualification` is `INVALID`,
`UNVERIFIED`, or `UNAVAILABLE` is downgraded to `INSUFFICIENT_EVIDENCE` — corrupt or unconfirmed
evidence can never support a positive result, for *any* control, regardless of whether that
control's own author remembered to check stream integrity. This is architectural, not conventional:
no evaluator opts in or out of it. See `auditor-evidence-model-v0.1.md` and
`auditor-v0.1-trust-closure.md` (Finding 1, TNA-41) for the full rationale, including why a
dependent control downgrades to `INSUFFICIENT_EVIDENCE` rather than `FAIL`, and why an irrelevant
corrupt stream elsewhere in the bundle never affects a control that didn't cite it.

## Negative evidence (sections 26-27)

Controls like `TNA-CAP-003` (capability revocation) and `TNA-REVOKE-001` (mid-execution revocation)
never conclude "revocation works" from the mere *absence* of a violation — that would be exactly the
"no synthetic pass from absence" anti-pattern section 26 forbids. They instead require **positive,
causal evidence of enforcement**: a revocation event followed by a demonstrable block/termination for
that same agent within the evidence window. No such enforcement evidence → `INSUFFICIENT_EVIDENCE`
(revocation observed but not proven enforced), never `PASS`.

## Profiles (sections 20-22)

Both `TNA_BASELINE_V01` and `TNA_HIGH_RISK_V01` select the *entire* catalog — the high-risk profile
does not add new controls (deliberately, per section 22: "Do not implement if it materially expands
scope"). It instead promotes a small, named set of controls (`TNA-RUNTIME-001` active monitoring,
`TNA-RUNTIME-005` authority revalidation, `TNA-CONTAIN-002` emergency stop) from their baseline
criticality to `CRITICAL` via `ControlProfile.criticality_overrides`, applied through
`effectiveCriticality(control, context)`. The same evaluator, the same evidence requirement, a
stricter bar for what counts as acceptable risk.

## Dependencies (section 28)

A control may declare `dependencies: string[]` (other `control_id`s it conceptually relies on — e.g.
`TNA-AUTH-002` depends on `TNA-AUTH-001`'s binding fields already being present). This is documentary
in v0.1 (no evaluator currently short-circuits based on a dependency's own result) — no circular
dependency exists in the catalog, and each evaluator remains independently computable from the
evidence bundle alone.

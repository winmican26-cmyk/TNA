# TNA Auditor v0.1 Proof of Work

## Accepted Baseline

- Volume 1 — TNA Gate v0.1 (tag `tna-gate-v0.1`, commit `4eca92790d530af73cd81a329ce8acf7085113f5`)
- Volume 2 — TNA Gate v0.2 (tag `tna-gate-v0.2`, commit `cdb53bec97d197214a7ca99a964f5d88324da693`)
- Volume 3 — TNA Gate v0.3 (tag `tna-gate-v0.3`, commit `718a801ff9e3085faf4e69d1dbf924a1b6e6c047`)
- Volume 4 — VAD Engine v0.1 (tag `vad-engine-v0.1`, commit `0667484cd6c63aef2be81ad85479a91c2bed631a`)
- Volume 5 — TNA Ledger v0.1 (tag `tna-ledger-v0.1`, commit `203b8fb6febe711f7c1f47fa6af8b542ea7f3185`)
- Volume 6 — TNA Sentinel v0.1 (tag `tna-sentinel-v0.1`, commit `eda35ecb14ee6c9e9f13112339cda6648cf92303`)

All six remain untouched. No accepted tag was moved or rewritten.

## Git State

- Branch: `trust-no-agent-main`
- HEAD entering this milestone: `3198e445e081a14fce1ea7a122b6dae1747dce90`
- This milestone's work is currently uncommitted in the working tree, presented for review before any
  commit/tag step, per the workflow established by every prior volume.

## Files Created

```
packages/auditor-schema/{package.json,src/index.ts}
packages/auditor-controls/{package.json,src/index.ts}
packages/auditor-evidence/{package.json,src/index.ts}
packages/auditor-risk/{package.json,src/index.ts}
packages/auditor-engine/{package.json,src/index.ts}
packages/auditor-report/{package.json,src/index.ts}
apps/tna-auditor/{package.json,src/{index,writers,ledger-adapter,server,main}.ts}
scripts/demo-auditor-v01.ts
tests/auditor/{fixture,auditor-schema,auditor-controls,auditor-risk,auditor-evidence,
  auditor-engine-smoke,auditor-engine,auditor-report-smoke,auditor-package,auditor-http,
  auditor-abuse-cases,auditor-adapters}.ts
docs/auditor/{auditor-overview-v0.1,auditor-assessment-spec-v1,auditor-control-model-v1,
  tna-control-catalog-v0.1,auditor-evidence-model-v0.1,auditor-risk-model-v0.1,
  auditor-finding-model-v0.1,auditor-report-model-v0.1,auditor-package-model-v0.1,
  auditor-ledger-integration-v0.1,auditor-threat-model-v0.1,auditor-verification-v0.1,
  auditor-requirement-matrix-v0.1,proof-of-work-auditor-v0.1}.md
```

## Files Modified

- `package.json` — added `demo:auditor:v01` and `start:auditor` scripts.
- `packages/ledger-schema/src/index.ts` — additive extension: `SourceComponent` gained `'auditor'`,
  `EVENT_TYPES` gained five `AUDIT_*` types. No existing value removed, renamed, or reordered — same
  discipline the Sentinel v0.1 milestone established. See `auditor-ledger-integration-v0.1.md`.
- `apps/tna-ledger/src/writers.ts` — additive: two new exported factories, `auditorWriter(tenantId)`
  and `auditorLedgerReader(tenantId)`. `gateWriter`, `vadWriter`, `sentinelWriter`, `reader`, `admin`
  are unmodified.
- `README.md` — added a Volume 7 status section, marked "in development" per section 135. No prior
  content removed or reworded.

No accepted Gate, VAD, Ledger, or Sentinel *behavior* was altered — the only accepted file touched
(`ledger-schema`) had values added to closed enums, never removed or changed in meaning, and all 406
pre-existing tests plus the demo remain green.

## Auditor Architecture

Six packages plus one app (section 4), consolidated deliberately where a seventh package would have
been decorative — no artificial micro-packages:

- **auditor-schema** — assessment spec/scope validation, controlled enums (result status, reason
  codes, severity, evidence source trust, finding status, assessment status/outcome, control profile
  ids), canonicalization/hashing, secret rejection, the universal `computeRiskContribution` mapping.
  No I/O.
- **auditor-controls** — the 27-control catalog, the two profiles, and every deterministic evaluator.
  No I/O — takes an already-collected `EvidenceBundle` and returns a `ControlResult`.
- **auditor-evidence** — `EvidenceProvider` interface, the Ledger-backed provider (the preferred
  source), a static fixture provider, and the implementation-evidence manifest model including the
  seeded accepted-baseline manifest (15 claims across all six accepted milestones).
- **auditor-risk** — pure risk scoring, coverage, overall-outcome, and finding-priority functions.
- **auditor-engine** — the durable SQLite store and `AuditorRuntime` facade: principals/roles, CAS-
  protected run claiming, the evidence-collection → evaluation → atomic-finalization pipeline,
  replay, findings, the implementation manifest's installation/retrieval.
- **auditor-report** — the JSON audit package builder, its self-contained verifier, and the Markdown
  report generator.
- **apps/tna-auditor** — fixed reader/runner/admin identities, `AuditorLedgerAdapter`, the HTTP API,
  the process entrypoint (opens the same Ledger database file the accepted `tna-ledger` app writes
  to, read-only).

## Responsibility Boundary

Auditor never authorizes activity, never executes containment, never rewrites evidence, and never
acts as verifier for VAD outputs — proven structurally: no method anywhere in `AuditorRuntime` calls
into Gate, Sentinel, or a containment interface; `LedgerEvidenceProvider` only ever reads through a
`reader`-role Ledger principal; there is no API that writes a `ControlResult`/`Finding`/`RiskSummary`
except the runtime's own deterministic `runAssessment`/`replayAssessment` pipeline (section 119 — no
`markControlPass`).

## Assessment Model

`AssessmentSpec` (`auditor-schema`) carries `version, tenant_id, name, description?, scope,
control_profile_id, evidence_cutoff_at` plus runtime-owned `assessment_id, created_at, created_by,
spec_hash`. A distinct, comprehensive `assessment_hash` is computed once at run completion (sections
42-43) — the documented two-hash boundary resolution is in `auditor-assessment-spec-v1.md`, the same
kind of explicit field-boundary documentation Sentinel used for its session/policy split.

## Assessment Lifecycle

`CREATED → COLLECTING_EVIDENCE → EVALUATING → COMPLETED | FAILED | INDETERMINATE`. A run left mid-
`COLLECTING_EVIDENCE`/`EVALUATING` at store-open time (simulating a process restart) is swept to
`INDETERMINATE` automatically in the constructor — proven directly with a simulated crash mid-run
followed by a real store close/reopen.

## Scope Model

`AssessmentScope` requires `time_range` always, and at least one of `agent_ids`/`correlation_ids`
non-empty **or** an explicit `tenant_wide: true` — an ambiguous scope is rejected outright, never
silently defaulting to "everything" (section 6).

## Control Catalog

27 controls across all 17 mandatory categories (`IDENTITY` through `RECOVERY`). Full detail:
`tna-control-catalog-v0.1.md`. None faked or partially stubbed — every evaluator is real,
deterministic TypeScript, tested with at least one PASS/FAIL/INSUFFICIENT_EVIDENCE fixture for every
security-critical (CRITICAL-criticality) control (section 25): `TNA-AUTH-001`, `TNA-CAP-003`,
`TNA-INTEG-001`, `TNA-CONTAIN-001`, `TNA-REVOKE-001`.

## Control Profiles

`TNA_BASELINE_V01` and `TNA_HIGH_RISK_V01` both select the full catalog; the high-risk profile
promotes `TNA-RUNTIME-001`, `TNA-RUNTIME-005`, `TNA-CONTAIN-002` to `CRITICAL` via
`criticality_overrides` rather than adding new controls (section 22's explicit "do not materially
expand scope" instruction, honored literally).

## Evidence Requirement Model

Every control declares `required_evidence: EvidenceRequirement[]` (descriptive: event types and/or
"requires a manifest claim"). The evaluator is the actual enforcement; `required_evidence` documents
what it looks for. See `auditor-control-model-v1.md`.

## Evidence Trust Model

`EVIDENCE_SOURCE_TRUST_LEVELS = TRUSTED_SYSTEM | VERIFIED_LEDGER | SIGNED_EXPORT |
CONFIGURATION_SNAPSHOT | OPERATOR_ASSERTION | UNTRUSTED_SELF_REPORT`. Every ref this milestone
actually produces is `VERIFIED_LEDGER` (Ledger events) or `TRUSTED_SYSTEM` (manifest claims) — no
code path ever lets an `OPERATOR_ASSERTION`/`UNTRUSTED_SELF_REPORT` satisfy a control.

## Ledger Evidence Provider

`LedgerEvidenceProvider` — the preferred, primary evidence source (section 13, 15). A genuine defect
was found and fixed here during verification: agent-scoped collection using only `getEventsByActor`
returned zero events against real `GateLedgerAdapter`-shaped evidence, because Gate records most
events' `actor` as the system component, not the agent. Fixed by querying the agent's own
`agent:<agentId>` stream plus a decision-id bridge (`getEventsByDecision`) that reaches correlated
cross-subsystem evidence (e.g. Sentinel's own stream). Documented limitation: VAD atom evidence
carries neither an agent stream nor `authority_context.agent_id`, so it is only reachable via
explicit `correlation_ids` in scope — stated plainly in `auditor-evidence-model-v0.1.md`, not silently
worked around. Bounded by `MAX_COLLECTED_EVENTS`, `MAX_PAGES_PER_QUERY`, and a runtime-owned 10s
collection timeout (section 66).

## Implementation Evidence Manifest

`ControlImplementationManifest` — hashed (`manifest_hash = hash(claims)`), only ever consulted after
`verifyManifestIntegrity` passes, only ever installable by an `admin` principal. Seeded via
`buildAcceptedBaselineManifest()`: 15 claims spanning all six accepted TNA milestones, each bound to
its exact accepted tag and commit SHA with a real test reference — including one claim citing the
Sentinel v0.1 concurrency-closure fix specifically for `TNA-CONTAIN-001`.

## Evidence Cutoff

Bound on every `AssessmentSpec`; `LedgerEvidenceProvider` filters strictly on each event's
runtime-assigned `received_at`, never a caller-supplied timestamp. Proven directly: an event written
to Ledger after the cutoff is excluded even when `collect()` runs well after that event exists
("evidence-after-cutoff race", section 107).

## Evidence Freshness

`TNA-CAP-003` implements section 17's own worked example directly: revocation-enforcement proof older
than 24 hours downgrades an otherwise-PASS result to `PARTIAL` with reason `EVIDENCE_STALE`.

## Evidence Integrity

`TNA-INTEG-001` FAILs on any `verifyStream`-invalid stream contributing evidence to the assessment.
`TNA-AUTH-001` additionally will not PASS on a fully-bound decision whose *own* stream fails
integrity, even in isolation from the dedicated integrity control (section 16's explicit guidance,
applied at the individual-control level too).

## Control Evaluation Engine

`evaluateControl(control, context, evidence)` — deterministic dispatch with a try/catch boundary
(sections 101-102): an evaluator that throws resolves to `ERROR`, never crashes the assessment and
never silently vanishes. Every result flows through one shared `finish()` builder, which is the sole
place `risk_contribution` is computed — no per-evaluator scoring logic.

## Gate Controls

`TNA-IDENT-001, TNA-AUTH-001, TNA-AUTH-002, TNA-APPR-001, TNA-CAP-001, TNA-CAP-002, TNA-CAP-003,
TNA-EXEC-001, TNA-ISO-001, TNA-SEC-001, TNA-EGR-001` — 11 controls over Gate/execution-broker/
isolation-runner/secret-broker evidence and implementation facts.

## VAD Controls

`TNA-EXEC-002, TNA-VER-001, TNA-VER-002` — bounded retries, producer/verifier separation, immutable
spec-hash binding, all against real `ATOM_*` event shapes.

## Ledger Controls

`TNA-EVID-001, TNA-INTEG-001, TNA-TEN-001` — append-only application surface, stream integrity, and
tenant isolation.

## Sentinel Controls

`TNA-RUNTIME-001..005, TNA-CONTAIN-001, TNA-CONTAIN-002, TNA-REVOKE-001, TNA-RECOV-001` — 9 controls,
including the containment-truthfulness control that directly references the Sentinel concurrency
closure pass.

## Result States

`PASS | PARTIAL | FAIL | NOT_APPLICABLE | INSUFFICIENT_EVIDENCE | ERROR` — all six exercised across
the suite; `INSUFFICIENT_EVIDENCE` and `ERROR` are never collapsed into `FAIL`, and `ERROR` is never
treated as `PASS` (`risk_contribution` equals `FAIL`'s).

## Findings

One `AuditFinding` per non-`PASS`/non-`NOT_APPLICABLE` control result, `status: OPEN` only (section
30 — no finding-management workflow built), deterministically ordered by severity → control-status →
id.

## Risk Model

`overall_risk_score` = mean of applicable `risk_contribution` values, overridden to exactly 100
whenever any applicable `CRITICAL`-criticality control is `FAIL`/`ERROR` (TNA-39, the critical-failure
floor) — proven with 25 passing LOW controls alongside one CRITICAL FAIL still yielding score 100.

## Coverage Model

`pass_count / applicable_count` (percent, integer, no false precision); `NOT_APPLICABLE` never counts
toward the denominator or as a pass.

## Overall Outcome

`FAIL` (any applicable CRITICAL FAIL) > `INSUFFICIENT_EVIDENCE` (any applicable CRITICAL
INSUFFICIENT_EVIDENCE/ERROR) > `PASS` (all applicable PASS) > `PASS_WITH_FINDINGS` (everything else) >
`ERROR` (degenerate: empty applicable set). Full decision-tree test coverage in
`auditor-risk.test.ts`.

## Runtime-Owned Run State

`run_number` is claimed atomically (`claimRun`/`claimReplayRun`, `state_version` CAS) — never
caller-selected, never resettable, monotonic per assessment. `control_catalog_version` and
`evaluator_version` are pinned at claim time from the runtime's own constants, never from caller
input (proven directly: an injected `control_catalog_version` field in the spec body is silently
dropped by validation and has no effect on the pinned value).

## Atomic Finalization

Control results, findings, the risk summary, the evidence-derived assessment_hash, and the run/
assessment status transition to `COMPLETED` all persist in one SQLite transaction — carrying forward
the VAD V3 lesson explicitly cited in the brief. Evidence-collection failure or an unexpected
evaluation-phase error resolves the run to `INDETERMINATE`/`FAILED` instead, never a fabricated
`COMPLETED`.

## Concurrency

Proven directly: two simultaneous `runAssessment` calls on the same assessment — exactly one wins the
claim, the other receives a `CONFLICT`, never a corrupted or duplicate run; 20 concurrently-evaluated
controls within one run are all persisted exactly once (`(tenant_id, assessment_id, run_number,
control_id)` primary key makes a duplicate contradictory result a schema impossibility, not merely an
application-level promise).

## Restart Persistence

A `COMPLETED` assessment survives closing and reopening the store with an identical `assessment_hash`
and full control-result set. A run interrupted mid-`EVALUATING` (simulated) recovers to
`INDETERMINATE` automatically on the next store open — never silently `COMPLETED`, never stuck.

## Tenant Isolation

Every `AuditorRuntime` query is `(tenant_id, ...)`-scoped. A cross-tenant caller naming a real
assessment id by guessing gets `NOT_FOUND`, not a usable handle or a confirming 403 — proven for
read, run, and replay independently, plus a listing-isolation test.

## Secret Handling

`findSecretShapedField` (same fixed rule set as the accepted Ledger/Sentinel detectors) rejects
secret-shaped spec fields before storage; the Markdown report is proven to never surface a
Bearer-token-shaped value even when a finding's own text happens to echo one.

## Resource Bounds

`MAX_CONTROLS_PER_ASSESSMENT` (100), `MAX_EVIDENCE_REFS_PER_CONTROL` (200), `MAX_FINDINGS_PER_RESPONSE`
(200), `MAX_EXPORT_BYTES`/`MAX_REPORT_BYTES` (8 MiB each), `MAX_QUERY_PAGE_SIZE` (200),
`MAX_COLLECTED_EVENTS` (5000), plus the HTTP layer's `MAX_BODY_BYTES` (64 KiB) — all enforced with
explicit, documented fail-closed behavior, never silent truncation of an artifact whose completeness
matters (the audit package/report throw `PAYLOAD_TOO_LARGE` rather than truncate).

## Reports

`buildMarkdownReport` — deterministic, template-based, no LLM prose. Executive summary, control
summary table, named sections for failed/partial/insufficient-evidence/errored controls (never buried
under a generic "passed" summary, section 100), findings, the mandatory limitations boilerplate,
replay metadata.

## Audit Package

`buildAuditPackage` — reads exclusively through `AuditorRuntime`'s own principal-gated accessors;
carries the mandatory `AUDITOR_LIMITATIONS` verbatim on every export; only exportable once a run is
`COMPLETED`.

## Package Verification

`verifyAuditPackage` — fully self-contained (no store, no principal). Recomputes `assessment_hash`
from the package's own declared content; independently checks finding→control-result and
control-result→evidence-manifest reference consistency.

## HTTP API

`apps/tna-auditor/src/server.ts` implements the section-53 endpoint set: assessment create/read/list,
run, replay, results, findings, runs, export, package verification, control/profile catalog browsing.
Every route requires a bearer credential (reader/runner/admin); no anonymous access anywhere; no
generic PATCH/PUT/DELETE mutation route exists for an assessment (proven with all three methods
against a live assessment, 404 and unchanged afterward).

## HTTP Integration Tests

`tests/auditor/auditor-http.test.ts` — 13 tests against the actual `createAuditorServer` over real
TCP with `fetch`, no facade mocking — the same discipline the Ledger closure pass and Sentinel
milestone established.

## Ledger Integration

`AuditorLedgerAdapter` proven end-to-end against the real `Ledger` facade: `AUDIT_*` events chain and
verify on their own `auditor:<assessmentId>` stream, and a non-`auditor`-bound principal cannot write
them.

## Failing-First Defects Found

Four real defects caught by running against realistic, real-Ledger-shaped evidence rather than
assuming correctness from inspection — full detail in `auditor-verification-v0.1.md`:

1. `LedgerEvidenceProvider`'s agent-scoping initially used only `getEventsByActor` and returned zero
   events against realistic Gate-adapter-shaped evidence.
2. `TNA-IDENT-001` required a field (`authority_context.agent_id` on `EXECUTION_STARTED`) the
   accepted Gate adapter never actually sets.
3. The seeded baseline manifest initially omitted two claims (`TNA-RUNTIME-002`/`003`), causing a
   fully-evidenced healthy fixture to under-perform its true posture.
4. Several test/demo fixtures needed completing to satisfy Ledger's own real (already-accepted)
   event-completeness invariants.

All four were root-caused by comparing expected vs. observed output from real execution.

## Abuse Cases

17 dedicated abuse-case tests (`sentinel-abuse-cases.test.ts`-style, `auditor-abuse-cases.test.ts`)
covering all 18 items from section 128: forged result/status fields, forged risk score/assessment
hash/run counters, forged control-catalog-version override, evidence_cutoff_at immutability, fake
trusted evidence refs, cross-tenant reads/evidence, unbounded findings requests, secret injection,
package tamper, hidden mutation routes, duplicate concurrent runs, run-number reset attempts,
evaluator-error laundering, high-risk-profile PASS without Sentinel evidence, and corrupt-Ledger
PASS attempts.

## Threat Model

25 threat categories, `auditor-threat-model-v0.1.md`, covering every item section 129 lists plus the
compromised-process, compromised-host, privileged-DB-rewrite, and false-compliance-claim limitations
sections 130-132 require to be stated explicitly.

## Regulatory / Certification Boundary

No code path in this milestone emits or implies an ISO 27001/SOC 2/NIST/EU AI Act/DORA/HIPAA/GDPR/
NIS2/PCI DSS status. `AUDITOR_LIMITATIONS` — the exact three sentences from sections 130-132 — is
attached to every exported package and every generated report, verbatim, every time (proven
directly). Section 94's regulatory-mapping structure is not implemented at all in v0.1, not even as
an empty/informational placeholder.

## Existing Regression Results

All 406 previously-accepted tests (Gate v0.1-v0.3, VAD Engine v0.1, Ledger v0.1, Sentinel v0.1 +
concurrency closure) remain green — verified as part of the 526-test full-suite run, not in isolation.

## Auditor Test Results

120 new tests across 11 files in `tests/auditor/` — exact breakdown in `auditor-verification-v0.1.md`.

## Total Test Reconciliation

406 (accepted baseline) + 120 (new Auditor) = 526. Node's test runner reported exactly 526 tests, 526
passed, 0 failed, in both consecutive `npm run check` runs — no estimation.

## First Clean Run

```
npm run check → 526 tests, 526 pass, 0 fail
Typecheck: PASS
Lint: PASS
Build: PASS
```

## Second Clean Run (Repeatability, no cleanup between runs)

```
npm run check → 526 tests, 526 pass, 0 fail
```

## Demo Output

```
npm run demo:auditor:v01
```

Printed, in order, every required line for Flow A (`AUDITOR STORE INITIALIZED` through `AUDIT PACKAGE
VERIFIED`, outcome `PASS_WITH_FINDINGS`), Flow B (missing-Sentinel high-risk assessment, outcome
`FAIL`), Flow C (corrupt-Ledger assessment, `LEDGER INTEGRITY CONTROL: FAIL`, outcome `FAIL`), Flow D
(containment uncertainty, `TNA-CONTAIN-001: FAIL`), and Flow E (`AUDIT PACKAGE VERIFICATION FAILED`
on a tampered package, reason `ASSESSMENT_HASH_MISMATCH`), then `TNA Auditor v0.1 demo passed.` (exit
code 0). Every outcome is genuinely computed by the real evaluation pipeline against real (in-memory
demo) Ledger evidence — none of the five flows' results are hardcoded or asserted without having
actually run.

## Remaining Limitations

- Export path safety (disk-write file paths) is not applicable — v0.1 has no file-path-shaped export
  API; packages/reports are returned as in-memory values.
- VAD atom evidence is not automatically discoverable from an agent-only assessment scope (documented
  limitation, `auditor-evidence-model-v0.1.md`) — requires explicit `correlation_ids`.
- No maturity score, no regulatory-mapping structure (even empty), no full finding-management
  workflow, no per-control Ledger evidencing — all deliberately out of scope for v0.1, not silent
  gaps.
- No cloud deployment, no dashboard/frontend, no SaaS billing layer, no AI-based scoring — all
  correctly out of scope for this milestone and not attempted.

## Requirement Scorecard

Full item-by-item scoring against the section-142 acceptance gate is in
`docs/auditor/auditor-requirement-matrix-v0.1.md`. Summary: every in-scope mandatory item is
IMPLEMENTED and TESTED, or explicitly NOT APPLICABLE by documented design. The two "known partial/out
of scope" items there are documented scope boundaries, not silent gaps or failed requirements.

## Mandatory Blockers Remaining

**0**

## Final Git Status

Branch `trust-no-agent-main`, HEAD `3198e445e081a14fce1ea7a122b6dae1747dce90` (unchanged by this
milestone). New Auditor files are currently untracked/uncommitted; `package.json`,
`packages/ledger-schema/src/index.ts`, `apps/tna-ledger/src/writers.ts`, and `README.md` are modified
in place (additive only, README status-section addition only). No accepted Gate, VAD, Ledger, or
Sentinel file was deleted or destructively modified; `master` and all six accepted tags
(`tna-gate-v0.1/v0.2/v0.3`, `vad-engine-v0.1`, `tna-ledger-v0.1`, `tna-sentinel-v0.1`) are untouched.

## Recommendation (original v0.1 submission)

> **READY FOR ARCHITECTURAL ACCEPTANCE REVIEW**

This implementation agent does not declare acceptance, and does not tag `tna-auditor-v0.1`.
Acceptance belongs to the reviewer.

---

## Addendum — Trust Closure Pass

Everything above this line is preserved exactly as originally submitted at the 526-test/5-flow
milestone — nothing above was edited or retracted. An architectural review conducted *after* that
point found two trust-boundary gaps (evidence-integrity qualification was per-control rather than
architectural; manifest hash integrity was being treated as sufficient for trust, conflating integrity
with authenticity). Full root-cause/fix/test detail is in `docs/auditor/auditor-v0.1-trust-closure.md`;
summary:

- **Finding 1 (TNA-41)**: a central `qualifyEvidenceIntegrity` gate now runs inside `evaluateControl`
  for every control except `TNA-INTEG-001`, downgrading any PASS/PARTIAL citing corrupt or unverified
  Ledger evidence to `INSUFFICIENT_EVIDENCE` — architectural, not per-evaluator convention.
- **Finding 2 (TNA-42)**: manifest trust now has two independent dimensions, `verifyManifestIntegrity`
  (hash) and `trust_class: ManifestTrustClass` (provenance). Only `BUILT_IN_ACCEPTED_BASELINE` —
  reachable through exactly one compiled code path, pinned to the six accepted tag/commit anchors —
  can automatically satisfy a claim; admin-installed manifests are always `ADMIN_PROVIDED` and are
  never wired into evaluation, no matter how internally hash-consistent they are.

Both qualification dimensions are now bound into `computeAssessmentHash` and exposed in the exported
audit package (`evidence_manifest[i].integrity_qualification`, `manifest_trust_summary.trust_class`),
with tampering either after export caught by `verifyAuditPackage`.

### Updated Test Reconciliation

526 (original baseline, unmodified) + 9 new trust-closure tests = **535**. Node's test runner reported
exactly 535 tests, 535 passed, 0 failed, in two consecutive `npm run check` runs (no cleanup between).

### Updated Demo Output

`npm run demo:auditor:v01` — all five flows still print every required line and exit 0. Flow C gained
one additional assertion (a dependent control, `TNA-AUTH-001`, resolves to explicit
`INSUFFICIENT_EVIDENCE` on corrupt evidence, not merely `!= PASS`). Flow D was redesigned to demonstrate
`TNA-CONTAIN-001`'s containment-truthfulness property with real evidence alone (a fabricated
`SENTINEL_TERMINATED` report over unconfirmed containment), since its previous manifest-swap mechanism
is now structurally impossible under Finding 2's fix — see `auditor-v0.1-trust-closure.md` for detail.
No other flow changed.

### Updated Mandatory Blockers Remaining

**0**

### Updated Recommendation

> **READY FOR ARCHITECTURAL ACCEPTANCE REVIEW**

Still does not declare acceptance and does not tag `tna-auditor-v0.1`. Acceptance belongs to the
reviewer, on top of both this document and `docs/auditor/auditor-v0.1-trust-closure.md`.

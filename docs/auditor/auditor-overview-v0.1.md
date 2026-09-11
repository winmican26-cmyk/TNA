# TNA Auditor v0.1 Overview

## Purpose

TNA Auditor is the governance, control-assessment, and evidence-backed risk-scoring layer of Trust
No Agent. It answers, on demand, against a bounded scope and a bounded window of evidence:

> Given the system that actually exists and the evidence it actually produced, which controls are
> satisfied, which are partially satisfied, which are unsupported, which have failed, and what
> residual risk remains?

**TNA Auditor evaluates configured controls against available evidence. It does not certify legal,
regulatory, contractual, or industry compliance.** No ISO 27001, SOC 2, NIST, EU AI Act, DORA, HIPAA,
GDPR, NIS2, or PCI DSS status is claimed or implied by any result this milestone produces. See
`auditor-threat-model-v0.1.md` for the full boundary.

## Responsibility boundary

```
TNA GATE       = MAY THE ACTION BEGIN?
VAD ENGINE     = DID PRODUCED WORK SATISFY ITS SPECIFICATION?
TNA LEDGER     = WHAT HAPPENED AND WHAT EVIDENCE EXISTS?
TNA SENTINEL   = IS RUNTIME BEHAVIOR STILL WITHIN SAFE AND AUTHORIZED BOUNDS?
TNA AUDITOR    = DO THE IMPLEMENTED CONTROLS AND AVAILABLE EVIDENCE SATISFY THE ASSESSMENT
                 REQUIREMENTS?
```

Auditor does not authorize activity (Gate's job), does not execute containment (Sentinel's job),
does not rewrite evidence (Ledger's job), and does not act as verifier for VAD outputs (VAD's job).
Auditor reads evidence and evaluates control coverage — nothing more.

## The pipeline

```
CONTROL CATALOG → ASSESSMENT SCOPE → REQUIRED EVIDENCE → EVIDENCE COLLECTION →
EVIDENCE VALIDATION → CONTROL EVALUATION → FINDINGS → RISK SCORE → REMEDIATION PRIORITY →
SIGNED/HASHED ASSESSMENT PACKAGE
```

## Core principles

- **No evidence ≠ pass.** A control with no supporting evidence returns `INSUFFICIENT_EVIDENCE`,
  never `PASS`.
- **Partial evidence ≠ full pass.** A control satisfied by some but not all required evidence
  returns `PARTIAL`.
- **Stale evidence ≠ current assurance.** Evidence past its freshness window cannot alone support a
  `PASS` (section 17).
- **Self-assertion ≠ trusted evidence.** Only `TRUSTED_SYSTEM`/`VERIFIED_LEDGER`/`SIGNED_EXPORT`
  sources can satisfy a control that requires system-generated evidence — an `OPERATOR_ASSERTION` or
  `UNTRUSTED_SELF_REPORT` never can on its own.
- **A control may pass only against its own explicit evidence requirements.**
- **A pass must be reproducible from the same evidence snapshot** (replay, section 39).

## Package layout

Six packages plus one app:

- **auditor-schema** — versioned assessment spec, scope, controlled enums (result status, reason
  codes, severity, evidence source trust, assessment status/outcome), canonicalization, hashing,
  secret rejection. No I/O.
- **auditor-controls** — the control catalog (~27 controls), the two profiles (`TNA_BASELINE_V01`,
  `TNA_HIGH_RISK_V01`), and every deterministic, side-effect-free control evaluator. No I/O.
- **auditor-evidence** — the `EvidenceProvider` interface, the Ledger-backed provider (the preferred
  evidence source), a static fixture provider for tests, and the implementation-evidence manifest
  model (including the seeded accepted-baseline manifest).
- **auditor-risk** — deterministic risk scoring (critical-failure floor), coverage calculation, and
  overall-outcome determination. Pure functions only.
- **auditor-engine** — the durable SQLite store and the `AuditorRuntime` facade: principals/roles,
  runtime-owned run numbering, the evidence-collection → evaluation → atomic-finalization pipeline,
  findings, replay.
- **auditor-report** — the portable JSON audit package builder, its self-contained verifier (tamper
  detection), and the deterministic Markdown report generator.
- **apps/tna-auditor** — fixed reader/runner/admin identities, the Ledger evidence-provider wiring,
  the Auditor→Ledger adapter, the HTTP API, the process entrypoint.

## What v0.1 does not build

No frontend. No SaaS billing layer. No external regulatory certification claims. No AI-based scoring
or generated prose (all risk scoring and report text is deterministic and template-based). No full
finding-management workflow (only `OPEN` findings in v0.1). No live queries into Gate/Sentinel/VAD's
own runtime APIs — TNA Ledger is the single live evidence source, supplemented by a static,
hash-verified implementation-evidence manifest for structural facts Ledger events don't naturally
carry. See the proof of work for the exact scope boundary.

## Documentation set

- `auditor-assessment-spec-v1.md` — the assessment model, scope, spec/assessment hash boundary.
- `auditor-control-model-v1.md` — the control and profile model, evaluator contract.
- `tna-control-catalog-v0.1.md` — every control: objective, evidence requirement, pass/fail rules.
- `auditor-evidence-model-v0.1.md` — the evidence bundle, provider, trust, freshness, conflict model.
- `auditor-risk-model-v0.1.md` — the exact scoring formula, coverage, and outcome logic.
- `auditor-finding-model-v0.1.md` — the finding model and prioritization.
- `auditor-report-model-v0.1.md` — the Markdown report structure.
- `auditor-package-model-v0.1.md` — the JSON audit package and its verification.
- `auditor-ledger-integration-v0.1.md` — the Ledger schema extension and Auditor's own event mapping.
- `auditor-threat-model-v0.1.md` — threat coverage and explicit non-mitigations.
- `auditor-verification-v0.1.md` — verification runs.
- `auditor-requirement-matrix-v0.1.md` — item-by-item scoring.
- `proof-of-work-auditor-v0.1.md` — the full closure proof.

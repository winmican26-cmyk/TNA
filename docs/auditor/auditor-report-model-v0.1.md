# TNA Auditor Report Model v0.1

`buildMarkdownReport(pkg: AuditPackage): string` (`packages/auditor-report`). Deterministic,
template-based — no LLM-generated prose anywhere (section 96).

## Structure

```
# TNA Audit Report
  (assessment metadata: name, id, tenant, profile, run number, evidence cutoff, catalog version
   — flags a catalog_version_mismatch inline if the replay ran under a newer catalog)

## Executive Summary
  outcome, overall risk level/score (+ "critical-failure floor applied" if so), critical failure
  count, high-finding count, controls passed/applicable, insufficient-evidence count, coverage %

## Control Summary
  a table of PASS/PARTIAL/FAIL/INSUFFICIENT_EVIDENCE/NOT_APPLICABLE/ERROR counts

## Failed Controls / Partial Controls / Controls Not Evaluated (Insufficient Evidence) / Evaluator
  Errors
  (each section present only if non-empty — section 100: insufficient-evidence controls are never
   buried under a generic "passed" summary; they get their own named section)

## Findings
  one line per finding: severity, control_id, title

## Limitations
  the mandatory AUDITOR_LIMITATIONS boilerplate, verbatim (see auditor-package-model-v0.1.md)

## Replay Metadata
  evaluator_version, is_replay, assessment_hash
```

## No false precision (section 36)

Coverage is rendered as an integer percentage (`78%`), never `77.523%`. Proven directly: a report
built from an unhealthy fixture never matches `/\d\.\d+%/`.

## Executive summary example (section 96)

```
Assessment outcome: FAIL
Critical failures: 1
High findings: 2
Controls passed: 18/24
Controls with insufficient evidence: 3
```

## Secrets never appear

Since the report is built purely from the already-validated `AuditPackage` (whose control results and
evidence refs never carry raw secret values — see `auditor-evidence-model-v0.1.md` and
`packages/auditor-schema`'s `findSecretShapedField`), the Markdown output structurally cannot surface
a secret the underlying data didn't already reject. Proven directly with a Bearer-token-shaped probe.

## Size bound

`buildMarkdownReport` enforces `MAX_REPORT_BYTES` (8 MiB) and throws `PAYLOAD_TOO_LARGE` rather than
silently truncating a report whose completeness matters (section 111: fail closed, documented
behavior — never a silent partial artifact).

## No PDF

v0.1 produces JSON (the audit package) and Markdown only (section 95). PDF generation is explicitly
out of scope for this milestone.

# Evidence Visualization v0.1

## Evidence Explorer (real `apps/tna-ledger`)

Search by correlation id / stream id / event type (bounded pagination, `nextCursor`-driven). Each result row
shows the real `LedgerEvent` fields: stream, sequence, event id, causation, source component, timestamp.
Integrity is a per-stream, on-demand real hash-chain verification (`GET
/api/evidence/streams/:id/verify`), rendered as `VERIFIED` / `CORRUPT` / `UNAVAILABLE` / `UNKNOWN` — never
defaulting to `VERIFIED`.

The whole-tenant verification (`GET /api/evidence/verify`) wraps the real `Ledger.verifyAll()` result
(`{validStreams, invalidStreams, ...}`) with one derived field: `valid: invalidStreams === 0`. **This is a
direct, non-fabricated projection of authoritative counts, not independently invented evidence** — the
undelying counts are exactly what the real Ledger computed.

## Audit / Assurance (real `apps/tna-auditor`)

Renders real `AssessmentRecord`s (`status`, `outcome`), real per-control results
(`PASS`/`PARTIAL`/`FAIL`/`NOT_APPLICABLE`/`INSUFFICIENT_EVIDENCE`/`ERROR`), and real findings.
`INSUFFICIENT_EVIDENCE` is a distinct, non-green result and is never remapped to a passing color. The
mandatory disclaimer is always shown:

> TNA Auditor evaluates configured controls against available evidence. It does not certify legal,
> regulatory, contractual, or industry compliance.

## Incidents — live aggregation, not a system of record

**No accepted TNA backend volume has a unified Incident abstraction or store.** Per the build order, this
is deliberately "the narrowest evidence-backed aggregation needed"
(`apps/tna-control-center/src/incidents.ts`): every incident is computed FRESH on each `GET /api/incidents`
request from real signals already fetched elsewhere in this BFF (Platform readiness, Client Gateway
connections/tools, Ledger's whole-tenant integrity check). Severity is one deterministic, backend-owned
table (`componentSeverity`, plus fixed per-type severities) — the frontend never assigns or overrides a
severity.

Acknowledging an incident (`POST /api/incidents/:signature/acknowledge`) records ONLY that a real human, at
a real time, acknowledged a specific real incident signature, in a small Control-Center-local SQLite table
(`control_center_incident_acknowledgments`). **This is acknowledgment metadata about human interaction with
the assurance view — it is never a claim that the underlying condition has resolved.** The same real
condition, if still true on the next poll, reappears with its acknowledgment shown alongside it, not
replaced by it.

## Recursive Improvement lineage

See `recursive-improvement-ui-v0.1.md` for the full treatment, including two explicitly honest gaps
(no numeric benchmark score, no "holdout" concept) that this page does not paper over.

## Notifications

A polling hook (`apps/tna-control-center-web/src/notifications.ts`, 20s interval) re-fetches the SAME
already-real `/api/incidents` and `/api/actions` (HELD) endpoints this app uses elsewhere and surfaces newly
-present items. No WebSocket, no new backend concept, no persisted notification history — dismissing a
notification only clears it from that browser tab's in-memory "seen" set.

# TNA Auditor — Ledger Integration v0.1

## Schema extension (sections 115-116)

`packages/ledger-schema` gained `'auditor'` as a `SourceComponent` and five `AUDIT_*` event types —
purely additive, same discipline as the Sentinel v0.1 extension:

```
AUDIT_ASSESSMENT_CREATED, AUDIT_ASSESSMENT_STARTED, AUDIT_FINDING_CREATED,
AUDIT_ASSESSMENT_COMPLETED, AUDIT_ASSESSMENT_FAILED
```

No existing `SourceComponent` or `EVENT_TYPES` value was removed, renamed, or reordered — every event
accepted under the tagged `tna-ledger-v0.1` commit (and every event added by the Sentinel v0.1
milestone) remains valid under this schema.

## Writer identity (section 117)

`apps/tna-ledger/src/writers.ts` gained `auditorWriter(tenantId)` (bound to `['auditor']`, matching
`sentinelWriter`'s pattern exactly) and `auditorLedgerReader(tenantId)` (a distinct id wrapping the
same generic `readerPrincipal` factory — Ledger has one reader *role*, not per-consumer ACLs, so this
is a naming/traceability distinction). `gateWriter`, `vadWriter`, `sentinelWriter`, `reader`, `admin`
are byte-for-byte unchanged.

## AuditorLedgerAdapter (section 115, 118)

Pure translation layer (`apps/tna-auditor/src/ledger-adapter.ts`) — never calls into
`AuditorRuntime`, never alters Ledger's own validation or hash-chain behavior, never mutates or
rewrites any prior evidence. Stream: one per assessment, `auditor:<assessmentId>`; `correlation_id`
is the assessment_id, so an assessment's full lifecycle — who ran it, against what scope, with what
outcome — is independently reconstructible from Ledger evidence alone (section 118), not only from
Auditor's own local SQLite store.

Events emitted: `assessmentCreated`, `assessmentStarted` (per run), `findingCreated` (per finding),
`assessmentCompleted` / `assessmentFailed`. **Deliberately does not** emit one event per control
evaluation (~27 per run) — that volume is disproportionate to what the evidence is for; the full
per-control trail remains queryable directly from `AuditorRuntime` and from the exported audit
package. This is a scoped, documented choice, not an oversight.

Proven directly against a real `Ledger` + `LedgerStore` (`tests/auditor/auditor-adapters.test.ts`):
every event type chains and verifies, and a non-`auditor`-bound principal cannot write them.

## Evidence direction (this is the important one)

Auditor's relationship with Ledger has two directions that must not be confused:

1. **Read** (primary): `LedgerEvidenceProvider` reads Gate/VAD/Sentinel evidence *out of* Ledger to
   evaluate controls (see `auditor-evidence-model-v0.1.md`). This is Auditor's main job.
2. **Write** (secondary, self-audit): `AuditorLedgerAdapter` writes Auditor's *own* activity *into*
   Ledger, so "who ran this assessment, against what scope, with what outcome" is itself durable,
   tenant-scoped evidence — not merely a claim Auditor's own local database makes about itself
   (section 118).

Auditor never uses (2) to satisfy any control it evaluates via (1) — its own lifecycle events are
`source_component: 'auditor'`, and no control in the catalog treats `'auditor'`-sourced events as
qualifying evidence for anything. This keeps the "system being evaluated ≠ component deciding whether
a control passed" separation (section 52) intact even for Auditor's own audit trail.

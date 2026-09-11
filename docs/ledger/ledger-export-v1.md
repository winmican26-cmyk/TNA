# TNA Ledger Export v1.0

Status: IMPLEMENTED, TESTED

## Format

`Ledger.exportEvidence(principal, correlationId)` (`packages/ledger-query/src/index.ts`,
`exportEvidence`) produces a JSON bundle:

```json
{
  "version": "1.0",
  "tenantId": "...",
  "correlationId": "...",
  "exportedAt": "...",
  "events": [ /* up to MAX_EXPORT_EVENTS (5000) LedgerEvent objects */ ],
  "streamHeads": [ /* head of every stream touched by these events */ ],
  "verification": [ { "streamId": "...", "valid": true } ],
  "exportHash": "sha256(...)"
}
```

NDJSON is not implemented in v0.1 — JSON only (section 66 marks NDJSON optional). No PDF reporting.

## Export hash

`exportHash = hash(canonical(bundle minus exportHash))`, using the same canonicalization as event
hashing. This lets a recipient verify the bundle was not modified in transit or storage after export,
independent of verifying the events' own internal chain.

## Verifying an exported bundle

`Ledger.verifyExportedBundle(principal, bundle)` needs no store access — it is a pure function over
the bundle's own contents:

1. Recompute the export hash; mismatch → `EXPORT_HASH_MISMATCH`.
2. For every stream present in the bundle, walk its included events in sequence order. **Only**
   check `previous_event_hash` continuity between two included events whose sequence numbers are
   exactly adjacent (`n` and `n+1`) — a correlation-scoped export legitimately omits events outside
   its correlation (e.g. an `AGENT_REGISTERED` event from earlier in the same stream), so the first
   included event of a stream is *not* required to chain back to `GENESIS`, and a sequence gap
   between two included events is not itself a fault. A gap simply means chain continuity cannot be
   checked across it — mismatch on a real adjacent pair → `CHAIN_BROKEN`.
3. Recompute each included event's `payload_hash` and `event_hash` independently; mismatch →
   `PAYLOAD_HASH_MISMATCH` / `EVENT_HASH_MISMATCH`.

This design was arrived at by a failing test: an initial implementation assumed every export was a
complete stream from `GENESIS` and failed on legitimate, correlation-scoped exports. The fix and the
regression test are in `tests/ledger/ledger-query.test.ts` and `scripts/demo-ledger-v01.ts`.

## Tamper detection

Modifying any field of any event in an exported bundle changes that event's canonical content, which
changes the overall bundle's canonical content, which is caught immediately by the `exportHash`
check — before the per-event chain/hash checks even run. Demonstrated in the demo (`EVIDENCE
EXPORTED` → `EXPORT VERIFIED` → tampered-copy check) and in `ledger-query.test.ts`.

## What is NOT in an export

No secrets (enforced upstream — a secret-shaped field could never have been persisted; see
`ledger-event-spec-v1.md` §secret rejection). No chain-of-thought or hidden reasoning traces (TNA
principle; the Ledger never stores those to begin with). The export is exactly the persisted,
already-sanitized evidence — nothing is redacted or added at export time in v0.1.

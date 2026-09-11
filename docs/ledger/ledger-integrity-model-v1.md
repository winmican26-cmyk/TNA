# TNA Ledger Integrity Model v1.0

Status: IMPLEMENTED, TESTED

## Canonicalization

`canonical()` (`packages/ledger-schema/src/index.ts`) recursively sorts object keys and serializes
deterministically, so `{a:1,b:2}` and `{b:2,a:1}` produce identical output and therefore identical
hashes. Arrays preserve order (order is meaningful there). `hash()` is `sha256(canonical(value))`.
Tested directly (`ledger-schema.test.ts`: stable under key reorder, changes under a material value
change) and indirectly by every tamper-detection test.

## What is hashed

Two separate hashes exist per event:

- **payload_hash** — `hash(payload ?? null)`. Covers only the free-form `payload` block.
- **event_hash** — `hash(EventHashCore)`, where `EventHashCore` binds `version, tenant_id,
  stream_id, sequence, event_id, event_type, occurred_at, actor, correlation_id, causation_id,
  parent_event_id, source_component`, all four context blocks, `payload_hash`, and
  `previous_event_hash`. The event's own `event_hash` is never an input to itself.

`occurred_at`, `causation_id`, and `parent_event_id` are always present in `EventHashCore` — as
`null` when absent, never omitted — because an omitted key and a `null`-valued key must canonicalize
identically at both write time and verify time, or a legitimate unmodified event could fail
verification purely from how the hash core was reconstructed (see the comment on `EventHashCore` in
`packages/ledger-schema/src/index.ts` for the specific bug this guards against).

The Ledger computes both hashes itself. A caller-supplied `event_hash` is not accepted as input at
all — `LedgerEventInput` has no such field.

## Hash chain

`previous_event_hash` of event *N* must equal `event_hash` of event *N-1* in the same stream; the
first event in a stream chains to the literal string `GENESIS`. Tampering with an earlier event
changes what a full-chain recompute expects at every later position, which is exactly what
`verifyStream` checks (see below) — it does not merely compare adjacent stored fields, since those
could be tampered together.

## verifyStream

`verifyStream(store, tenantId, streamId)` (`packages/ledger-integrity/src/index.ts`) recomputes the
entire chain from stored rows and checks, per event in sequence order:

1. `sequence` is exactly `expectedSequence` (no gap, no duplicate) — `SEQUENCE_GAP_OR_DUPLICATE`.
2. `previous_event_hash` equals the previous event's *actual* `event_hash` (recomputed, not merely
   read back) — `PREVIOUS_HASH_MISMATCH`.
3. Recomputing `payload_hash` from the stored `payload` matches the stored `payload_hash` —
   `PAYLOAD_HASH_MISMATCH`.
4. Recomputing `event_hash` from all stored fields matches the stored `event_hash` —
   `EVENT_HASH_MISMATCH`.

After the loop, the stream head's `latest_sequence` and `latest_event_hash` must match what was
just recomputed — `STREAM_HEAD_SEQUENCE_MISMATCH` / `STREAM_HEAD_MISMATCH`.

On any failure, the stream is persisted as `INVALID` (`store.markStreamInvalid`) unless the caller
explicitly asked for a read-only probe (`{ persist: false }`, used internally by export verification
so that generating an export never has the side effect of quarantining a stream).

## verifyAll

A full, unoptimized scan over every stream (section 33) — acceptable at v0.1's local scale, not
something that should be assumed to hold at high stream counts. Returns
`{ streamsChecked, eventsChecked, validStreams, invalidStreams, firstFailure, durationMs }`.

## Startup check vs. full verification

Opening a `LedgerStore` runs a **cheap** check: for each stream, recompute the hash of only its
*last* row and compare against the stored head (`verifyStreamHeadsOnStartup`). This catches a head
that disagrees with its own last event, but it cannot catch tampering of an earlier row in a
multi-event stream, or tampering of the `event_hash` column value itself (which isn't an input to
its own recomputation) on the head row specifically. Detecting those requires an explicit
`verifyStream`/`verifyAll` call — startup is a smoke test, not a substitute for full verification.
This distinction is deliberate (recomputing every stream fully on every process start would not
scale) and is proven by test: a tamper of a non-head row is invisible to startup but caught by
`verifyStream` (`ledger-integrity.test.ts`).

## Fail-closed

Once a stream is `INVALID`, `LedgerStore.append` rejects any further write to it with
`INTEGRITY_FAILURE` — including from a fully-authorized writer — until an administrative repair
process (not built in v0.1) intervenes. Reads remain available so the corrupted evidence can still
be inspected forensically; the Ledger never presents `INVALID` evidence as verified (section 86).

## What this does NOT claim

Hash chaining detects tampering performed through anything other than direct control of both the
database file and the application's hashing logic. It does **not** claim tamper-proof, WORM, or
cryptographically-undeniable storage: an attacker with sufficient database and application-code
control can rewrite history and recompute a self-consistent chain from scratch (section 36, TNA
threat model). External anchoring (e.g. periodic hash publication to an independent system) is
future work, not implemented here.

## Clock ownership

Event timestamps are Ledger-owned: `received_at` and `persisted_at` are always set from the store's
own clock (`Date.now` by default, injectable for tests) at append time, never from caller input.
A caller may supply `occurred_at` describing when the source claims the event happened; it is
validated as a well-formed ISO-8601 UTC timestamp but is never treated as authoritative for
ordering. Stream `sequence` — not any timestamp — is authoritative for order within a stream.
Cross-stream, cross-system ordering from wall-clock timestamps alone is not claimed; clock skew
between components is a known limitation (section 60).

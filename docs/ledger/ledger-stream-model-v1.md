# TNA Ledger Stream Model v1.0

Status: IMPLEMENTED, TESTED

## Why per-stream chains, not one global chain

A single global hash chain across every tenant, agent, and atom would serialize all writes across
the entire platform behind one sequence counter — a concurrency bottleneck and an unnecessary
coupling between unrelated workflows. TNA Ledger instead partitions the hash chain by **stream**:
each stream has its own independent, monotonically-sequenced chain.

## Stream identity

A stream is identified by `(tenant_id, stream_id)`. Stream uniqueness always includes `tenant_id`
(section 55) — the same `stream_id` string under two tenants is two entirely separate chains that
never interact (tested in `tests/ledger/ledger-security.test.ts`, "cross-tenant stream isolation").

## Partitioning convention (v0.1)

| Domain | Stream id | Rationale |
|---|---|---|
| Gate | `agent:<agentId>` | One agent's full authorization/capability/execution history chains together, in order. |
| VAD | `atom:<atomId>` | One atom's full lifecycle — creation through acceptance — chains together. |

This is a convention enforced by the adapters (`apps/tna-ledger/src/gate-adapter.ts`,
`vad-adapter.ts`), not by the store itself — the store accepts any caller-chosen `stream_id`. A
future milestone could introduce additional partitions (e.g. `execution:<executionId>`) without a
schema change.

## Sequence numbers

Each stream has a monotonically increasing `sequence` starting at 1. The store assigns it — callers
never supply or select it. Appending reads the current stream head inside one transaction, computes
`sequence = head.latest_sequence + 1`, and writes both the event row and the updated head atomically
(`LedgerStore.append`, `packages/ledger-store/src/index.ts`). Ten concurrent appends to the same
stream produce ten unique, contiguous sequence numbers (`tests/ledger/ledger-store.test.ts`).

## Stream head

`ledger_streams` holds one row per `(tenant_id, stream_id)`: `latest_sequence`, `latest_event_hash`,
`updated_at`, `integrity_status`. It is updated in the same transaction as the event insert — there
is no window where an event exists but the head does not reflect it, or vice versa.

## Correlation vs. causation vs. stream

Three distinct groupings answer three distinct questions:

- **stream_id** — which hash chain is this event part of (the integrity unit).
- **correlation_id** — which workflow does this event belong to (used for reconstruction and
  export; may span or be narrower than a stream — e.g. an `AGENT_REGISTERED` event correlates to
  the agent's own lifecycle, not to any one authorization decision made later in the same stream).
- **causation_id** — the specific prior event that directly caused this one (e.g. a
  `CAPABILITY_REDEEMED` event's `causation_id` points at the `CAPABILITY_ISSUED` event id it
  redeemed). This is finer-grained than correlation and is what lets a reader answer "why did this
  specific event happen" rather than only "what else happened in this workflow."

## Append-only

Normal Ledger APIs expose no update or delete of a persisted event (section 23; verified by
inspection of `apps/tna-ledger/src/server.ts` — no `PUT`/`PATCH`/`DELETE` route exists for
`/v1/ledger/events`). A correction is a new event that references the one it corrects — v0.1 does
not yet define a dedicated `CORRECTION` event type; that is future work, not a gap papered over with
a mutation API.

## Fail-closed on corruption

If `ledger_streams.integrity_status = INVALID` for a stream, `LedgerStore.append` refuses further
writes to it with `INTEGRITY_FAILURE`, regardless of writer identity (section 85, TNA-25). See
`ledger-integrity-model-v1.md`.

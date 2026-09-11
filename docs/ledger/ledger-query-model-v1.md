# TNA Ledger Query Model v1.0

Status: IMPLEMENTED, TESTED

## Methods

All defined in `packages/ledger-query/src/index.ts`, exposed through `Ledger` (`packages/ledger-core`)
with tenant scoping and role checks applied:

- `getEvent(eventId)` — exact lookup.
- `getStream(streamId, limit?, cursor?)` — bounded, paginated (closed in the Final Acceptance
  Closure Pass). Returns `{ items, nextCursor }` with the same `DEFAULT_QUERY_PAGE_SIZE` /
  `MAX_QUERY_PAGE_SIZE` / clamp / opaque-cursor behavior as every other paginated method. An
  ordinary caller cannot retrieve an unlimited stream through this path. Ordering within a single
  `stream_id` is the stream's hash-chain (sequence) order — see §deterministic ordering. Integrity
  verification does **not** use this path: `verifyStream` reads the whole stream through the
  internal `LedgerStore.listStream` primitive, which is intentionally left as the trusted internal
  full-read mechanism and was not weakened to suit public pagination.
- `getEventsByActor`, `getEventsByCorrelation`, `getEventsByType`, `getEventsByTimeRange` — paginated.
- `getEventsByDecision`, `getEventsByExecution`, `getEventsByAtom` — context-field lookups
  (`authority_context.decision_id`, `execution_context.execution_id`, `spec_context.atom_id`).
- `search` — combines any of `actorId, correlationId, eventType, streamId, fromTime, toTime` in one
  paginated query.

## Parameterization

Every SQL query in `LedgerStore` binds values through prepared-statement placeholders (`?`) — no
request-derived string is ever concatenated into SQL text. Column and table names are fixed at
compile time and never derived from caller input. Tested directly: a filter value shaped like
`"a1'; DROP TABLE ledger_events; --"` is treated as a literal string that matches nothing, not as
SQL (`ledger-store.test.ts`, "query filters are parameterized").

## Pagination

- `limit` defaults to `DEFAULT_QUERY_PAGE_SIZE` (50) and is capped at `MAX_QUERY_PAGE_SIZE` (200) —
  a caller asking for more silently gets the cap, not an error and not unbounded output.
- `cursor` is an opaque base64url-encoded offset. It is a simple offset cursor, not a keyset cursor —
  correct and bounded, but not the most efficient scheme at very large offsets. Sufficient for v0.1
  scale; documented as a known simplification, not represented as a scalable design.
- A page result is `{ items, nextCursor }`; `nextCursor` is `null` exactly when there is no further
  page (proven by requesting one page size larger than available data).

## Deterministic ordering

Every paginated and context-field query orders by `received_at, stream_id, sequence, event_id` (in
that priority). This is fixed, not caller-configurable, so the same query against the same data
always returns events in the same order — required for reconstruction and export to be reproducible.

## Field-lookup queries are full scans (documented, not hidden)

`getEventsByDecision/Execution/Atom` (via `LedgerStore.findByContextField`) scan a tenant's rows and
filter on a parsed JSON context field in application code, because SQLite has no native index into
the JSON blobs stored in `authority_context`/`spec_context`/`execution_context`. This is acceptable
at v0.1's local scale (the columns are already narrowed by `tenant_id` and, where possible, an
`event_type IN (...)` list) but would need a real index (e.g. a generated column, or moving these
identifiers into first-class indexed columns) before it could be called production-scale. No claim
of scalability is made here.

# TNA Ledger v0.1 Requirement Matrix

Scored against the Volume 5 acceptance gate (section 120). Status language: IMPLEMENTED, TESTED,
PARTIAL, NOT IMPLEMENTED, FUTURE, NOT APPLICABLE (section 99).

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | All 163 pre-existing accepted tests remain green | TESTED | `npm run check`, 250/250 total, twice consecutively |
| 2 | All Ledger tests pass | TESTED | 87 tests, `tests/ledger/*.test.ts` (56 core + 8 bounded-stream + 23 HTTP integration) |
| 3 | Typecheck clean | TESTED | `npm run typecheck` |
| 4 | Lint clean | TESTED | `npm run lint` |
| 5 | Build clean | TESTED | `npm run build` |
| 6 | Strict Ledger Event v1 schema | IMPLEMENTED, TESTED | `packages/ledger-schema` |
| 7 | Controlled event types | IMPLEMENTED, TESTED | 32-type registry, unknown type rejected |
| 8 | Actor provenance | IMPLEMENTED, TESTED | controlled `ActorType` enum, no free-form |
| 9 | Source-component provenance | IMPLEMENTED, TESTED | controlled enum + writer binding |
| 10 | Canonical event hashing | IMPLEMENTED, TESTED | `canonical()`/`hash()`, key-order-independent |
| 11 | Payload hash | IMPLEMENTED, TESTED | `payload_hash` column, verified independently of `event_hash` |
| 12 | Previous-event hash | IMPLEMENTED, TESTED | `previous_event_hash`, GENESIS at stream start |
| 13 | Stream hash chaining | IMPLEMENTED, TESTED | `verifyStream` full-chain recompute |
| 14 | Monotonic stream sequence | IMPLEMENTED, TESTED | assigned inside the append transaction |
| 15 | Concurrent append safe | TESTED | 10 concurrent appends → 10 unique sequential sequences |
| 16 | Stream head updated atomically | IMPLEMENTED, TESTED | same transaction as the event insert |
| 17 | Event history append-only through public API | IMPLEMENTED | no update/delete route for events |
| 18 | Conflicting duplicate rejected | IMPLEMENTED, TESTED | `EVENT_CONFLICT` |
| 19 | Identical duplicate idempotent | IMPLEMENTED, TESTED | same id + same content → same row returned |
| 20 | Integrity verifier detects altered payload | TESTED | `ledger-integrity.test.ts` |
| 21 | Integrity verifier detects altered hash | TESTED | event-hash and previous-hash tamper cases |
| 22 | Integrity verifier detects sequence/link break | TESTED | sequence-gap and previous-hash-mismatch cases |
| 23 | Corrupted stream blocks further writes | IMPLEMENTED, TESTED | fail-closed `INTEGRITY_FAILURE` |
| 24 | Durable restart persistence | TESTED | close/reopen, identical hashes, `demo:ledger:v01` |
| 25 | Tenant isolation | IMPLEMENTED, TESTED | tenant-scoped principals, cross-tenant read/write/stream tests |
| 26 | Query API/methods work | IMPLEMENTED, TESTED | 9 query methods + `search`; `getStream` is now bounded/paginated too |
| 27 | Query results bounded (incl. `getStream`) | IMPLEMENTED, TESTED | `MAX_QUERY_PAGE_SIZE` cap; `getStream` no longer returns an unbounded array — defaults to `DEFAULT_QUERY_PAGE_SIZE`, clamps oversized `limit`, rejects non-positive `limit` and invalid cursor, traverses gap-free/dup-free via cursor (`tests/ledger/ledger-stream-pagination.test.ts`, `ledger-http.test.ts`) |
| 28 | Deterministic ordering | IMPLEMENTED, TESTED | `received_at, stream_id, sequence, event_id`; verified stable across repeated `getStream` calls and equal to sequence order within a stream |
| 29 | Gate workflow reconstructs | IMPLEMENTED, TESTED | `reconstructGateAction`, demo Flow A |
| 30 | VAD workflow reconstructs | IMPLEMENTED, TESTED | `reconstructVadAtom`, demo Flow B |
| 31 | Portable JSON evidence export | IMPLEMENTED, TESTED | `exportEvidence` |
| 32 | Exported evidence verifiable | IMPLEMENTED, TESTED | `verifyExportedBundle` |
| 33 | Export tampering detected | TESTED | export-hash mismatch on any field change |
| 34 | Secrets not stored | IMPLEMENTED, TESTED | `findSecretShapedField`, 6 secret-shape tests |
| 35 | Oversized payload fails closed | IMPLEMENTED, TESTED | `PAYLOAD_TOO_LARGE` before persistence |
| 36 | Governed agent cannot forge SYSTEM evidence | IMPLEMENTED, TESTED | no writer identity is ever issued to an agent |
| 37 | Writer identity binds source component | IMPLEMENTED, TESTED | `allowedSourceComponents` allowlist per writer |
| 38 | Gate adapter exists | IMPLEMENTED | `apps/tna-ledger/src/gate-adapter.ts` |
| 39 | VAD adapter exists | IMPLEMENTED | `apps/tna-ledger/src/vad-adapter.ts` |
| 40 | Demo passes | TESTED | `npm run demo:ledger:v01`, all required output lines present |
| 41 | Check passes twice consecutively | TESTED | see `ledger-verification-v0.1.md` |
| 42 | Threat model complete | IMPLEMENTED | `ledger-threat-model-v0.1.md`, 15 threat categories |
| 43 | Requirement matrix complete | IMPLEMENTED | this document |
| 44 | Proof-of-work complete | IMPLEMENTED | `proof-of-work-ledger-v0.1.md` |
| 45 | No Sentinel built | NOT APPLICABLE | out of scope for Volume 5 by design |
| 46 | No Auditor built | NOT APPLICABLE | out of scope for Volume 5 by design |
| 47 | No frontend built | NOT APPLICABLE | out of scope for Volume 5 by design |
| 48 | No blockchain added | NOT APPLICABLE | hash chain + durable storage only |
| 49 | No unrelated feature expansion | NOT APPLICABLE | scope held to Gate/VAD evidence ingestion, integrity, query, export |

## Closed during the Final Acceptance Closure Pass

| Area | Prior status | Now | Evidence |
|---|---|---|---|
| `getStream` bound | PARTIAL — no hard cap on a single stream fetch | IMPLEMENTED, TESTED | `Ledger.getStream` returns a bounded `Page<LedgerEvent>` (default `DEFAULT_QUERY_PAGE_SIZE`, clamp at `MAX_QUERY_PAGE_SIZE`, opaque cursor); an ordinary caller can no longer retrieve an unlimited stream through the public query path. Integrity verification is unaffected — `verifyStream` still reads the whole stream through the internal `LedgerStore.listStream` primitive, which was deliberately left as the trusted internal mechanism and not weakened. `tests/ledger/ledger-stream-pagination.test.ts` (8 tests) + HTTP-level pagination coverage in `ledger-http.test.ts`. |
| HTTP API surface | IMPLEMENTED, NOT INDEPENDENTLY TESTED | IMPLEMENTED, TESTED | `tests/ledger/ledger-http.test.ts` (23 tests) drives the actual `createLedgerServer` over real TCP with `fetch` — no facade mocking. Covers: writer append, anonymous/unknown-token 401, reader-cannot-append 403, Gate↔VAD source impersonation 403, malformed JSON 400, wrong content-type 415, unsupported version 400, unknown type 400, oversized payload 413, retrieve-by-id 200 / unknown-id 404, tenant-scoped read, cross-tenant read isolation, cross-tenant write rejection 403, bounded stream + search pagination with cursor, invalid/unsupported query param 400, verify endpoint, reconstruction endpoint, and absence of PATCH/PUT/DELETE event routes (404). |

## Known partial/limitation items (not blockers, documented honestly)

| Area | Status | Detail |
|---|---|---|
| Causation reference existence | PARTIAL | business-level invariants (capability/execution/atom/agent) are enforced; a generic "does causation_id reference a real event" check is not |
| Export truncation signal | PARTIAL | `MAX_EXPORT_EVENTS` caps the bundle; the bundle does not carry an explicit `truncated` field the way reconstruction does |
| Reserved event types with no adapter yet | PARTIAL | `ATOM_STARTED`, `POLICY_ISSUED/REPLACED`, `AUTHORIZATION_REQUESTED/HELD`, `APPROVAL_*`, `INTEGRITY_CHECK_*` validate correctly but nothing in `apps/tna-ledger` currently emits them |
| Correction/amendment event type | NOT IMPLEMENTED | section 24's correction model is a documented future pattern, not a shipped event type |
| Privileged database rewrite | NOT APPLICABLE (by design) | explicitly not claimed to be prevented — see threat model |
| External anchoring | FUTURE | not implemented |

## Mandatory blockers remaining: 0

Every item in the acceptance-gate checklist (section 120) that is in scope for Volume 5 is
IMPLEMENTED and TESTED or NOT APPLICABLE by design. The "known partial" items above are documented
scope boundaries, not failures of a required item.

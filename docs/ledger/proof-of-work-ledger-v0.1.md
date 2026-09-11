# TNA Ledger v0.1 Proof of Work

> **Updated by the Final Acceptance Closure Pass.** Two architectural acceptance blockers were
> closed — `getStream` is now bounded/paginated, and a dedicated HTTP integration suite now exercises
> the real server. No other feature was added. Test total: 219 → **250**. Historical discussion of
> the two defects found during the original build (export verification, bearer-secret detection) is
> retained below and permanently covered by tests.

## Accepted Baseline

- Volume 1 — TNA Gate v0.1 (tag `tna-gate-v0.1`)
- Volume 2 — TNA Gate v0.2 (tag `tna-gate-v0.2`)
- Volume 3 — TNA Gate v0.3 (tag `tna-gate-v0.3`)
- Volume 4 — VAD Engine v0.1 (tag `vad-engine-v0.1`, commit `0667484cd6c63aef2be81ad85479a91c2bed631a`)

All four remain untouched. No accepted tag was moved or rewritten. `master` remains at the original
Gate v0.1 baseline, also untouched.

## Git State

- Branch: `trust-no-agent-main`
- HEAD entering this milestone: `fb688024cbc3712cf51432b4a93753ebb8aefa93`
- This milestone's work is currently uncommitted in the working tree (staged for review, not yet
  committed — commit is a separate, explicit step after acceptance review per the session's working
  agreement).

## Files Created

```
packages/ledger-schema/{package.json,src/index.ts}
packages/ledger-store/{package.json,src/index.ts}
packages/ledger-integrity/{package.json,src/index.ts}
packages/ledger-query/{package.json,src/index.ts}
packages/ledger-core/{package.json,src/index.ts}
apps/tna-ledger/{package.json,src/{index,gate-adapter,vad-adapter,writers,server,main}.ts}
scripts/demo-ledger-v01.ts
tests/ledger/{fixture,ledger-schema,ledger-store,ledger-integrity,ledger-query,ledger-security}.test.ts
tests/ledger/{ledger-stream-pagination,ledger-http}.test.ts   # Final Acceptance Closure Pass
docs/ledger/{ledger-event-spec-v1,ledger-stream-model-v1,ledger-integrity-model-v1,
  ledger-query-model-v1,ledger-reconstruction-v1,ledger-export-v1,ledger-threat-model-v0.1,
  ledger-verification-v0.1,ledger-requirement-matrix-v0.1,schema-evolution}.md
```

~2,140 lines across implementation, tests, and adapters (docs and package.json files excluded from
that count).

## Files Modified

- `package.json` — added `demo:ledger:v01` and `start:ledger` scripts.
- `README.md` — added Volume 4 (VAD Engine) and Volume 5 (TNA Ledger) status sections. Volume 5's
  status line was later updated, in a documentation-only follow-up commit, from "in development" to
  reflect its accepted state (see Architectural Acceptance below). No prior content removed.

No file belonging to an accepted milestone was altered in a way that changes its behavior.

## Ledger Architecture

Five packages plus one app, matching the recommended structure with no decorative micro-packages:

- **ledger-schema** — event shape, controlled enums, canonicalization, hashing primitives,
  completeness rules, secret rejection. No I/O.
- **ledger-store** — the durable SQLite engine: transactional append, sequencing, hash-chain
  construction, stream heads, raw parameterized queries. Knows nothing about writer identity or
  cross-event invariants.
- **ledger-integrity** — `verifyStream`/`verifyAll`, built only on `ledger-store`'s public read
  methods (no private access).
- **ledger-query** — read methods, pagination, Gate/VAD reconstruction, export/export-verification.
- **ledger-core** — the `Ledger` facade: the *only* sanctioned entry point. Every method takes a
  `LedgerPrincipal` and enforces role/tenant/source-component authorization before touching the
  store. Also owns cross-event invariant enforcement (it needs both schema validation and store
  lookups, which is why it sits above both).
- **apps/tna-ledger** — writer-identity factories, Gate/VAD evidence adapters, the HTTP API, and the
  process entrypoint. Nothing here changes Gate or VAD's own behavior.

Responsibility boundary preserved: the Ledger never decides whether an agent may act (Gate) or
whether produced work is correct (VAD) — `ledger-core`'s class-level comment states this explicitly,
and no method in `Ledger` makes an authorization or correctness judgment; it only records and
verifies evidence about decisions made elsewhere.

## Event Schema v1

`version: "1.0"` only; unsupported versions are rejected, not reinterpreted. Required fields:
`event_id, event_type, tenant_id, stream_id, actor{type,id}, correlation_id, source_component`.
Optional-with-explicit-absence: `causation_id, parent_event_id, occurred_at`, four context blocks
(`authority_context, spec_context, execution_context, artifact_context`), `payload`,
`classification`, `retention`. Full field-by-field spec: `docs/ledger/ledger-event-spec-v1.md`.

## Event Types

All 32 types from the Volume 5 registry are defined and pass validation. No extension mechanism
exists — an unknown type is a hard rejection (`UNKNOWN_EVENT_TYPE`). 21 of the 32 have a producing
adapter method in v0.1 (the Gate and VAD flows actually exercised); the remaining 11
(`ATOM_STARTED`, `POLICY_ISSUED/REPLACED`, `AUTHORIZATION_REQUESTED/HELD`, `APPROVAL_*`,
`INTEGRITY_CHECK_*`) validate correctly but have no adapter wired up yet — documented as PARTIAL in
the requirement matrix, not silently omitted.

## Actor and Source Identity

`ActorType` is a fixed 8-value enum; `SourceComponent` is a fixed 6-value enum. Both reject
free-form strings at validation time — `tests/ledger/ledger-schema.test.ts`.

## Stream Model

Per-`(tenant_id, stream_id)` independent hash chains, not one global chain (avoids serializing all
writes platform-wide behind one sequence). Convention: `agent:<agentId>` for Gate,
`atom:<atomId>` for VAD, chosen by the adapters, not enforced by the store. Full design rationale
and the correlation-vs-causation-vs-stream distinction: `docs/ledger/ledger-stream-model-v1.md`.

## Canonicalization

`canonical()` recursively sorts object keys; `hash()` is `sha256(canonical(value))`. `{a:1,b:2}` and
`{b:2,a:1}` hash identically; a materially different value hashes differently — both proven directly
in `ledger-schema.test.ts`, and indirectly by every integrity/export test that depends on
recomputation matching stored values.

## Hash Model

Two hashes per event: `payload_hash` (over `payload` alone) and `event_hash` (over every hash-bound
field including `payload_hash` and `previous_event_hash`, but never over itself). The Ledger computes
both — `LedgerEventInput` has no caller-settable `event_hash` field at all. A subtlety documented and
fixed during implementation: `occurred_at`/`causation_id`/`parent_event_id` are always present in the
hash-core input (as `null` when absent, never omitted), because an omitted key and a `null` key must
canonicalize identically at both write time and verify time or an honest, unmodified event would fail
verification purely from how the hash core was reconstructed from stored columns. See
`docs/ledger/ledger-integrity-model-v1.md`.

## Append Transaction

`LedgerStore.append` runs inside `BEGIN IMMEDIATE`/`COMMIT`: check idempotency → check stream-head
integrity status (fail-closed if `INVALID`) → assign next sequence → compute both hashes → insert the
event row → update the stream head — all in one transaction, rolled back entirely on any failure. No
partial append is possible.

## Concurrency

10 concurrent (interleaved-microtask) appends to the same stream produce 10 unique, contiguous
sequence numbers and one hash-chain-valid stream — `tests/ledger/ledger-store.test.ts`, matching the
same concurrency-testing pattern already established for `execution-broker` in this repository.

## Idempotency

Same `event_id` + identical canonical content → the original row is returned, no duplicate insert.
Same `event_id` + different content → `EVENT_CONFLICT`. Both proven directly.

## Integrity Verification

`verifyStream` recomputes an entire stream's chain from stored rows: sequence continuity, previous-
hash linkage, payload-hash recomputation, event-hash recomputation, and stream-head consistency.
`verifyAll` aggregates across every stream for a tenant. Both documented in
`docs/ledger/ledger-integrity-model-v1.md`.

## Corruption Handling

Five distinct tamper shapes are each independently detected: payload, event_type, a
stream-reassignment that creates a sequence gap, previous_event_hash, and event_hash —
`tests/ledger/ledger-integrity.test.ts`. A stream marked `INVALID` (whether by the cheap startup
check or by an explicit `verifyStream`/`verifyAll` call) blocks further appends
(`INTEGRITY_FAILURE`) regardless of writer identity, until an administrative repair process — not
built in v0.1 — intervenes. Reads remain available for forensic inspection.

## Gate Adapter

`apps/tna-ledger/src/gate-adapter.ts` maps existing Gate/broker evidence shapes
(`agent_id, decision_id, capability_id, execution_id, policy_hash, ...` — field names taken directly
from `packages/capability-core` and `packages/execution-broker`) into `LedgerEventInput` objects for
`AGENT_REGISTERED, AUTHORIZATION_ALLOWED, CAPABILITY_ISSUED, CAPABILITY_REDEEMED, EXECUTION_STARTED,
EXECUTION_SUCCEEDED, EXECUTION_FAILED, AGENT_REVOKED`. It does not call into or modify Gate's own
code — it is a pure translation layer the demo and a future integration would call after Gate
already made its decision.

## VAD Adapter

`apps/tna-ledger/src/vad-adapter.ts` maps VAD lifecycle steps into `ATOM_CREATED,
ATOM_ATTEMPT_STARTED, ATOM_ATTEMPT_FAILED, ATOM_VALIDATION_PASSED, ATOM_VERIFICATION_ACCEPTED/
REJECTED, ATOM_HUMAN_DECISION, ATOM_ACCEPTED/REJECTED/ESCALATED`. `VadExecution` (`packages/
vad-runtime`) exposes no lifecycle hooks, so the adapter is driven explicitly by the caller after
each step rather than by introspecting VAD's private state — it does not alter VAD's acceptance
logic in any way.

## Query Engine

9 methods (`getEvent`, `getStream`, `getEventsByActor/Correlation/Type/TimeRange` paginated,
`getEventsByDecision/Execution/Atom` context-field lookups, `search` combining any filter set). All
SQL is parameterized — proven with a `DROP TABLE`-shaped filter value that matches nothing rather
than executing. Pagination is capped at `MAX_QUERY_PAGE_SIZE` (200) with an opaque offset cursor;
ordering is fixed (`received_at, stream_id, sequence, event_id`).

**`getStream` is bounded** (closed in the Final Acceptance Closure Pass): it returns a
`Page<LedgerEvent>` (`{ items, nextCursor }`), defaults to `DEFAULT_QUERY_PAGE_SIZE` (50), clamps
`limit` above `MAX_QUERY_PAGE_SIZE` rather than erroring, rejects a non-positive `limit` and an
invalid cursor with `INVALID_EVENT` (HTTP 400), and traverses a whole stream via cursor with no gaps
and no duplicates. An ordinary caller can no longer pull an unlimited stream through the public query
path. Integrity verification is untouched: `verifyStream` still reads the entire stream through the
internal `LedgerStore.listStream` primitive, which was deliberately kept as the trusted internal
full-read mechanism and not weakened for pagination convenience. Proven by
`tests/ledger/ledger-stream-pagination.test.ts` (8 tests) and the HTTP-level pagination test in
`ledger-http.test.ts`.

## Reconstruction

`reconstructGateAction` and `reconstructVadAtom` walk a correlation's events and derive a structured
narrative (who/why/what/tool/resource/approval/capability/execution/outcome for Gate;
atom/attempts/validation/verification/humanDecision/finalState for VAD), each carrying the exact
list of event references it was built from. Both bounded at `MAX_RECONSTRUCTION_EVENTS` (500) and
report `truncated: true` rather than silently dropping events — proven with a 501-event correlation.

## Export

`exportEvidence` produces a self-contained JSON bundle (events + stream heads + per-stream
verification + an `exportHash` over the whole bundle). `verifyExportedBundle` needs no store access.
A real design bug was caught and fixed here: the first implementation assumed every export was a
complete stream from `GENESIS`, which failed on the demo's own genuine, correlation-scoped Gate
export. Fixed to only require chain continuity between two included events whose sequence numbers
are actually adjacent. Full account in `docs/ledger/ledger-export-v1.md` and
`ledger-verification-v0.1.md`.

## Tenant Isolation

Every `Ledger` method requires a tenant-scoped principal; stream uniqueness includes `tenant_id`, so
the same `stream_id` string under two tenants never interacts. Three dedicated tests: a reader can't
see another tenant's events, a writer can't append into a tenant it isn't bound to, and the same
stream id under two tenants stays fully separate (independent sequences, independent content).

## Secret Handling

`findSecretShapedField` rejects (does not hash-and-store) any payload or context value with a
secret-shaped key name or a bearer-token-shaped value, recursively. Six required test cases from
section 76 all pass, including the literal `Authorization: Bearer ...` case — which required fixing
an over-anchored regex during this session (see `ledger-verification-v0.1.md` §failing-first
examples). This is a fixed rule set, not general secret detection; documented as such.

## Resource Bounds

`MAX_PAYLOAD_BYTES` (8192), `MAX_QUERY_PAGE_SIZE` (200), `MAX_RECONSTRUCTION_EVENTS` (500),
`MAX_EXPORT_EVENTS` (5000) are all enforced before the corresponding operation completes, not applied
as an afterthought truncation.

## Threat Model

15 threat categories covering event forgery, source impersonation, duplication, mutation,
truncation/reordering/hash replacement, payload tampering, causation forgery, cross-tenant read/write,
secret leakage, oversized payload, query injection, unbounded export/reconstruction, corrupt-stream
continuation, privileged database rewrite (explicitly NOT mitigated, by design), and clock spoofing.
Full detail: `docs/ledger/ledger-threat-model-v0.1.md`.

## Failing-First Tests

Two real defects were caught by the test/demo suite before being trusted as correct, not asserted
fixed without verification:

1. `verifyExportedBundle`'s GENESIS assumption broke on the demo's own genuine correlation-scoped
   Gate export (5 of 6 events; `AGENT_REGISTERED` correctly excluded).
2. `SECRET_VALUE_PATTERN` was anchored to the start of the string (`/^Bearer\s+\S+/i`), so
   `"Authorization: Bearer abc123"` was not caught — the exact case section 76 requires.

Both are detailed with the observed failure, root cause, and fix in
`docs/ledger/ledger-verification-v0.1.md`.

## Existing Regression Results

All 163 previously-accepted tests (Gate v0.1–v0.3, VAD Engine v0.1) remain green — verified as part
of the 250-test full-suite run, not run in isolation and assumed unaffected. The two defects found
during the original v0.1 build (export verification's GENESIS assumption; the over-anchored
bearer-secret regex) remain permanently covered by their regression tests and were not disturbed.

## Ledger Test Results

87 Ledger tests across 7 files:

- `ledger-schema.test.ts` — 16 tests (version/type/actor/source rejection, completeness rules, 6
  secret-shape cases including `Authorization: Bearer ...`, oversized payload, canonicalization).
- `ledger-store.test.ts` — 7 tests (idempotency, conflict, sequencing, stream head, concurrency,
  restart persistence, injection-safety).
- `ledger-integrity.test.ts` — 8 tests (5 tamper shapes, fail-closed writes, startup check scope,
  `verifyAll` aggregation).
- `ledger-query.test.ts` — 9 tests (pagination, page-size cap, ordering, context-field queries,
  search, Gate/VAD reconstruction, export + tamper, reconstruction truncation).
- `ledger-security.test.ts` — 16 tests (writer source binding, role separation ×3, event forgery,
  tenant isolation ×3, 5 orphan/invariant pairs).
- `ledger-stream-pagination.test.ts` — **8 tests, Final Acceptance Closure Pass** (bounded default
  page, smaller limit honored, clamp above maximum, non-positive limit rejected, invalid cursor
  rejected, gap-free/duplicate-free cursor traversal, deterministic ordering across calls,
  cross-tenant pagination isolation).
- `ledger-http.test.ts` — **23 tests, Final Acceptance Closure Pass** (real `createLedgerServer`
  over TCP with `fetch`, no facade mocking: writer append 201, anonymous/unknown-token 401,
  reader-cannot-append 403, Gate↔VAD source impersonation 403 ×2, malformed JSON 400, wrong
  content-type 415, unsupported version 400, unknown type 400, oversized payload 413, retrieve 200 /
  unknown-id 404, tenant-scoped read, cross-tenant read isolation, cross-tenant write 403, bounded
  stream + search pagination with cursor, invalid/unknown query param 400, verify endpoint,
  reconstruction endpoint, no PATCH/PUT/DELETE event routes 404 ×3).

## Total Test Reconciliation

163 (accepted baseline) + 56 (core Ledger) + 8 (bounded-stream, closure pass) + 23 (HTTP
integration, closure pass) = 250. Node's test runner reported exactly 250 tests, 250 passed, 0
failed, in both consecutive `npm run check` runs — no estimation.

## First Clean Run

```
npm run check → 250 tests, 250 pass, 0 fail
Typecheck: PASS
Lint: PASS
Build: PASS
```

## Second Clean Run (Repeatability, no cleanup between runs)

```
npm run check → 250 tests, 250 pass, 0 fail
```

## Demo Output

```
npm run demo:ledger:v01
```

produced, in order: `LEDGER STORE INITIALIZED`, `GATE EVENTS APPENDED`, `GATE STREAM VERIFIED`,
`GATE ACTION RECONSTRUCTED`, `VAD EVENTS APPENDED`, `VAD STREAM VERIFIED`, `VAD ATOM RECONSTRUCTED`,
`EVIDENCE EXPORTED`, `EXPORT VERIFIED`, `TAMPER DETECTED`, `STORE REOPENED`, `PERSISTED STREAM
VERIFIED`, then `TNA Ledger v0.1 demo passed.` (exit code 0).

## Restart Persistence

Both the demo and a dedicated test (`ledger-store.test.ts`, "restart persistence") write events,
close the store, reopen it from the same file, and confirm identical event hashes and a
`verifyStream` pass — no in-memory state is required for correctness after reopening.

## Tamper Detection Proof

The demo deliberately builds a *separate, dedicated* store (never the live demo data used for the
Gate/VAD/export/restart proof), appends two events, closes it, directly rewrites one row's
`event_type` column via a raw `node:sqlite` connection, reopens it, and shows `verifyStream` fail
plus a subsequent append being blocked with `INTEGRITY_FAILURE`. The test suite additionally proves
detection for payload, sequence, previous-hash, and event-hash tampering independently.

## Remaining Limitations

- Causation existence is checked only for the specific business invariants listed (capability/
  execution/atom/agent), not generically for every `causation_id`/`parent_event_id` reference.
- Export does not carry an explicit truncation flag when a correlation exceeds `MAX_EXPORT_EVENTS`.
- 11 of 32 registered event types have no producing adapter yet (validate correctly, unused).
- No correction/amendment event type is implemented (design-only, section 24).

Closed in the Final Acceptance Closure Pass (previously listed here):

- ~~`getStream` has no hard event-count cap~~ → now bounded/paginated, 8 dedicated tests + HTTP
  coverage.
- ~~The HTTP API has no dedicated HTTP-level test suite~~ → `tests/ledger/ledger-http.test.ts`, 23
  tests against the real server.
- Hash chaining does not and cannot prove immutability against an attacker with direct database and
  application-code control — external anchoring is future work.
- No cloud deployment, no Sentinel, no Auditor, no frontend, no blockchain — all correctly out of
  scope for this milestone and not attempted.

## Requirement Scorecard

Full item-by-item scoring against the section-120 acceptance gate is in
`docs/ledger/ledger-requirement-matrix-v0.1.md`. Summary: every in-scope mandatory item is
IMPLEMENTED and TESTED, or NOT APPLICABLE by explicit design (Sentinel/Auditor/frontend/blockchain
exclusions). The "known partial" items listed there and repeated above are documented scope
boundaries, not silent gaps or failed requirements.

## Mandatory Blockers Remaining

**0**

## Final Git Status

Branch: `trust-no-agent-main`

Accepted implementation commit:
`203b8fb6febe711f7c1f47fa6af8b542ea7f3185`

Acceptance metadata commit:
`9d1c417228e5affd787518d3c5ad13bc05d00f85`

Current HEAD:
`bd3b77b9d84e67e098b58a9873dc9e736c076cbb`

Accepted tag:
`tna-ledger-v0.1`

Tag target:
`203b8fb6febe711f7c1f47fa6af8b542ea7f3185`

Working tree:
clean

No accepted Gate or VAD file was deleted or destructively modified; `master` and all four accepted
tags (`tna-gate-v0.1/v0.2/v0.3`, `vad-engine-v0.1`) are untouched and unmoved.

## Recommendation

> **ARCHITECTURALLY ACCEPTED AS TNA LEDGER v0.1**
> **WITH DOCUMENTED SCOPE AND LIMITATIONS**

This does not mean production certified, externally security audited, tamper-proof, compliance
certified, or universally secure — see Architectural Acceptance below for the full scope of what
acceptance does and does not cover.

## Architectural Acceptance

Status:
ARCHITECTURALLY ACCEPTED AS TNA LEDGER v0.1
WITH DOCUMENTED SCOPE AND LIMITATIONS

Accepted implementation commit:
`203b8fb6febe711f7c1f47fa6af8b542ea7f3185`

Accepted tag:
`tna-ledger-v0.1`

Tag target:
`203b8fb6febe711f7c1f47fa6af8b542ea7f3185`

Acceptance test baseline:
250 tests / 250 pass / 0 fail

Repeatability:
Two consecutive full `npm run check` runs passed with no cleanup between them.

Demo:
`npm run demo:ledger:v01` — PASS

Mandatory blockers remaining:
0

### What "architecturally accepted" does and does not mean

`ARCHITECTURALLY ACCEPTED` means the design and implementation satisfy the Volume 5 acceptance gate
for their stated scope, with the limitations documented in this file and in
`ledger-requirement-matrix-v0.1.md` / `ledger-threat-model-v0.1.md` understood and accepted.

It does **not** mean any of the following:

- production certified
- externally security audited
- tamper-proof
- compliance certified
- universally secure

Hash chaining plus durable storage is an integrity-evidence mechanism, not a WORM or
immutability guarantee against an actor with direct database and application-code control — see the
threat model's residual-risk section. External anchoring remains future work.

### Tag / HEAD relationship

The `tna-ledger-v0.1` tag points at the accepted implementation snapshot
(`203b8fb6febe711f7c1f47fa6af8b542ea7f3185`). Recording this acceptance metadata is a separate,
later documentation commit, so branch `trust-no-agent-main` HEAD is expected to sit one commit ahead
of the tag. The tag is not moved forward.

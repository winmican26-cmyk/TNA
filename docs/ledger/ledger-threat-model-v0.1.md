# TNA Ledger v0.1 Threat Model

Status: IMPLEMENTED IN PART

## Assets

- Event identity and idempotency (no silent duplication, no silent conflict)
- Hash-chain integrity per stream
- Actor / source-component provenance
- Cross-tenant isolation
- Evidence completeness (a "successful" event cannot exist without its causal predecessor)
- Exported evidence integrity

## Threats

### Event forgery

An untrusted caller submits an event claiming a privileged outcome (e.g. `ATOM_ACCEPTED`,
`actor.type: SYSTEM`) without holding the corresponding writer identity.

Mitigation: `Ledger.append` requires a `LedgerPrincipal` with `role: 'writer'`; a governed agent is
never issued one (only four fixed service identities exist — `ledger-writer-gate`,
`ledger-writer-vad`, `ledger-reader`, `ledger-admin` — see `apps/tna-ledger/src/writers.ts`). Tested:
`ledger-security.test.ts`, "event forgery".

### Source impersonation

A writer credential bound to one component claims to be a different one (e.g. a Gate writer
appending an event with `source_component: 'vad-engine'`).

Mitigation: each writer principal carries an explicit `allowedSourceComponents` allowlist, checked
on every append (section 80). Tested: "writer source binding".

### Duplicate event

The same `event_id` is submitted twice, by retry or by accident.

Mitigation: same id + same canonical content is idempotent (no duplicate row); same id + different
content is `EVENT_CONFLICT`. Tested: `ledger-store.test.ts`.

### Event mutation

An attempt to change a persisted event through the public API.

Mitigation: no update/delete route exists for `/v1/ledger/events` (section 115); the store's only
event-writing method is `append`.

### Stream truncation / reordering / hash replacement / payload tampering

Direct database tampering with any hash-bound field, at any position in a stream.

Mitigation: `verifyStream` recomputes the entire chain and detects sequence gaps, broken
previous-hash linkage, payload_hash mismatch, and event_hash mismatch (section 35). Tested with five
distinct tamper shapes in `ledger-integrity.test.ts`. Residual risk: an attacker with both database
and application hashing-code control can rewrite history and recompute a self-consistent chain —
see "Privileged database rewrite" below.

### Causation forgery

An event claims a `causation_id` or a context-field linkage (e.g. `capability_id`) to a prior event
that does not exist.

Mitigation: cross-event invariants (section 62) reject `CAPABILITY_REDEEMED` without a prior
`CAPABILITY_ISSUED`, `EXECUTION_SUCCEEDED/FAILED/TERMINATED/INDETERMINATE` without a prior
`EXECUTION_STARTED`, `ATOM_ACCEPTED` without prior `ATOM_VERIFICATION_ACCEPTED` and
`ATOM_HUMAN_DECISION`, and `AGENT_REVOKED` referencing an unregistered agent — all as `ORPHAN_EVENT`
rejections, not silent acceptance (section 63). Tested: `ledger-security.test.ts`, five orphan cases.
PARTIAL: only the invariants above are enforced; `causation_id`/`parent_event_id` themselves are
validated as well-formed identifiers but not verified to reference an existing event id (a generic
"does this event id exist" check was judged lower-value than the specific business invariants above,
which is what section 62 asks for — "implement only invariants that can be enforced locally/
reliably").

### Cross-tenant read / write

A reader or writer scoped to one tenant accesses or affects another tenant's data.

Mitigation: every `Ledger` method requires `principal.tenantId` and enforces it against the
requested resource; stream uniqueness includes `tenant_id`, so the same `stream_id` string under two
tenants is two unrelated chains. Tested: `ledger-security.test.ts`, three tenant-isolation cases.

### Secret leakage

A payload or context block contains an API key, password, bearer token, or similar.

Mitigation: `findSecretShapedField` rejects known secret-shaped keys and bearer-token-shaped values
before persistence (section 76). This is a fixed rule set, not general secret detection — a secret
with no recognizable key name or shape (e.g. a bare high-entropy string under an innocuous key) would
not be caught. No claim of comprehensive DLP is made (section 27).

### Oversized payload

A payload large enough to exhaust storage or memory.

Mitigation: `MAX_PAYLOAD_BYTES` (8192, canonical-serialized) enforced before persistence,
`PAYLOAD_TOO_LARGE`. Tested.

### Query injection

A filter value crafted to break out of a SQL query.

Mitigation: every `LedgerStore` query is parameterized; no request-derived string is concatenated
into SQL. Tested with a `DROP TABLE`-shaped filter value.

### Unbounded export / reconstruction

A correlation with unbounded event count is requested for export or reconstruction.

Mitigation: `MAX_EXPORT_EVENTS` (5000) and `MAX_RECONSTRUCTION_EVENTS` (500) cap what is fetched;
reconstruction reports `truncated: true` rather than silently omitting events (section 96). Export
does not currently report truncation as a field — PARTIAL — a caller exporting more than 5000 events
in one correlation gets the first 5000 without an explicit truncation flag in the bundle; the count
of `events` in the returned bundle is the only signal today.

### Orphan events

Covered under "Causation forgery" above.

### Corrupt stream continuation

A stream already known to be `INVALID` receives further writes, extending a corrupted history.

Mitigation: `LedgerStore.append` checks `integrity_status` before assigning a sequence and refuses
with `INTEGRITY_FAILURE` if `INVALID` (fail-closed, section 85, TNA-25). Tested.

### Privileged database rewrite

An attacker with direct database file access and knowledge of the hashing scheme rewrites history
and recomputes a self-consistent chain from scratch.

Mitigation: **none, by design of what hash chaining can prove.** This is explicitly not claimed to
be prevented (section 36, 94). Hash chaining proves that the currently-stored history is internally
consistent; it cannot prove that history was never rewritten by someone with sufficient access.
External anchoring (publishing chain heads to an independent system on a schedule) would raise the
cost of an undetected rewrite and is future work, not implemented in v0.1.

### Clock spoofing from source

A source component supplies a false `occurred_at` to misrepresent when something happened.

Mitigation: `occurred_at` is validated as well-formed but never authoritative — `received_at` and
`persisted_at` are always Ledger-clock-derived, and stream `sequence` (not any timestamp) is
authoritative for ordering within a stream (section 58-60).

## Residual risk summary

TNA Ledger v0.1 proves internal consistency of its own stored evidence and proves that evidence
cannot be forged, mutated, or orphaned through its public API. It does not prove that its underlying
storage was never rewritten outside that API by an operator with sufficient privilege, and it does
not implement general secret detection or DLP. Both are documented limitations, not silent gaps.

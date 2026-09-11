# TNA Ledger v0.1 Verification

## Command

```bash
npm run check   # typecheck && lint && build+test
```

Run twice consecutively, no manual cleanup between runs (section 104).

## Observed Output — Run 1

- Typecheck: PASS
- Lint: PASS
- Build: PASS
- Total tests: 250
- Passed: 250
- Failed: 0

## Observed Output — Run 2 (immediately after, no cleanup)

- Total tests: 250
- Passed: 250
- Failed: 0

## Reconciliation against the accepted baseline

The accepted baseline going into Volume 5 was 163 tests (Gate v0.1–v0.3 + VAD Engine v0.1). This
milestone adds 87 Ledger tests:

- 56 core tests — `tests/ledger/{ledger-schema,ledger-store,ledger-integrity,ledger-query,
  ledger-security}.test.ts` (initial v0.1 build).
- 8 bounded-stream tests — `tests/ledger/ledger-stream-pagination.test.ts` (Final Acceptance
  Closure Pass).
- 23 HTTP integration tests — `tests/ledger/ledger-http.test.ts` (Final Acceptance Closure Pass),
  driving the real `createLedgerServer` over TCP with `fetch`, no facade mocking.

163 + 56 + 8 + 23 = 250, matching the Node test runner's reported total exactly — no estimation.

## Final Acceptance Closure Pass — what changed

Two architectural acceptance blockers were closed; no other feature was added.

1. **`getStream` is now bounded.** The initial v0.1 `Ledger.getStream` returned an unbounded
   `LedgerEvent[]`. It now returns a bounded `Page<LedgerEvent>` (`{ items, nextCursor }`) with the
   same `DEFAULT_QUERY_PAGE_SIZE` / `MAX_QUERY_PAGE_SIZE` / clamp / opaque-cursor semantics as every
   other paginated query. `verifyStream` was **not** touched — it still reads a whole stream through
   the internal `LedgerStore.listStream` primitive, which remains the trusted internal full-read
   mechanism. New tests prove: bounded default page, honored smaller limit, clamp (not reject) above
   maximum, rejection of non-positive limit and of an invalid cursor, gap-free/duplicate-free cursor
   traversal, deterministic ordering across repeated calls, and cross-tenant pagination isolation.
2. **Dedicated HTTP integration suite.** 23 tests against the actual server — see the reconciliation
   list above and `ledger-requirement-matrix-v0.1.md` for the covered behaviors.

## Demo

```bash
npm run demo:ledger:v01
```

Printed, in order: `LEDGER STORE INITIALIZED`, `GATE EVENTS APPENDED`, `GATE STREAM VERIFIED`,
`GATE ACTION RECONSTRUCTED`, `VAD EVENTS APPENDED`, `VAD STREAM VERIFIED`, `VAD ATOM RECONSTRUCTED`,
`EVIDENCE EXPORTED`, `EXPORT VERIFIED`, `TAMPER DETECTED`, `STORE REOPENED`, `PERSISTED STREAM
VERIFIED`, then `TNA Ledger v0.1 demo passed.` — exit code 0.

## Failing-first examples

Two real bugs were caught by writing the test/demo before trusting the implementation, not found by
inspection after the fact:

1. **Export verification assumed a full stream.** The first `verifyExportedBundle` implementation
   required the first included event's `previous_event_hash` to equal `GENESIS`. The demo's Gate
   export is correlation-scoped (`decision_id`) and legitimately excludes the stream's first event
   (`AGENT_REGISTERED`, which correlates to the agent's lifecycle, not the decision) — so a genuine,
   untampered export failed verification. Fixed by only checking continuity between two included
   events whose sequence numbers are actually adjacent. See `ledger-export-v1.md`.
2. **Secret-value pattern was over-anchored.** `SECRET_VALUE_PATTERN` was `/^Bearer\s+\S+/i`
   (anchored to the start of the string), so a payload note reading `"Authorization: Bearer
   abc123"` was not rejected — the required test case from section 76 failed. Fixed by removing the
   `^` anchor so the pattern matches anywhere in the string.

Both were caught by the test suite in this session, not asserted as fixed without re-running.

## Meta-evidence

250 passing tests establish that the implemented behaviors pass their own checks. They do not, by
themselves, establish that every Volume 5 requirement is implemented to the letter — v0.1 targets
the accountability-critical subset (schema strictness, hash-chain integrity, tenant isolation,
writer-identity binding, orphan rejection, reconstruction, export, bounded retrieval, and an
HTTP surface exercised end-to-end) rather than every numbered item in the originating spec verbatim. The requirement matrix (`ledger-requirement-matrix-v0.1.md`) and
threat model (`ledger-threat-model-v0.1.md`) are the honest accounting of what is and is not covered.

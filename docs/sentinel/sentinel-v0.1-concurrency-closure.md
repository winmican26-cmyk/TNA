# TNA Sentinel v0.1 — Concurrency Closure Pass

## Origin

`sentinel-v0.1-architectural-review-v1.md` (preserved unmodified — this document does not revise or
retract it) identified one confirmed architectural blocker in the otherwise-accepted-pending Sentinel
v0.1 implementation, reproduced independently outside the test suite: a manual `hold()` racing a
rule-triggered `TERMINATE` could leave the persisted session `status` reporting `HELD` even though
`containment.terminate()` had genuinely fired. This document is the closure of that finding — a
narrow, scoped fix plus a permanent regression suite. It does not begin any new Sentinel feature work,
and it does not declare `tna-sentinel-v0.1` accepted; that remains the reviewer's call.

## Failing-first evidence

**Before this closure pass** (reproduced by the architectural review, and again here against the
pre-fix code before any of the changes below were applied):

```
hold() call resolved with session status: HELD
submitObservation resolved with decision: TERMINATE
FINAL PERSISTED SESSION STATUS: HELD
containment.hold() invocations: 1 | containment.terminate() invocations: 1
=> MISMATCH: real containment.terminate() fired, but persisted status is "HELD" -- the record no
   longer reflects that the session was actually terminated.
```

**After this closure pass**, the identical scenario (now `tests/sentinel/
sentinel-concurrency-closure.test.ts`, "BEFORE/AFTER regression: a slow-to-confirm manual HOLD racing
a fast-confirmed rule TERMINATE must resolve to TERMINATED, never HELD"):

```
✔ BEFORE/AFTER regression: a slow-to-confirm manual HOLD racing a fast-confirmed rule TERMINATE
  must resolve to TERMINATED, never HELD (161.4ms)
```

`containment.terminateCalls.length === 1` and `getSession().status === 'TERMINATED'` in both delay
orderings (hold slow/terminate fast, and the reverse) — see that test file for the full matrix.

## Root cause (unchanged from the architectural review's diagnosis)

`SentinelRuntime.applyOutcome()` computed a session's target status once, from a `session` snapshot
read earlier in the call, and wrote it unconditionally at the end — no check against the row's
*current* status, no compare-and-swap. Two independent evaluations of the same session (their own
containment calls resolving at different times) each wrote `status` from their own stale snapshot;
whichever write committed last won, regardless of severity.

## The fix

**Not last-write-wins, and not a numeric severity table bolted onto every lifecycle transition.**

The existing `sentinel-engine` function `nextStatusForDecision(current, decision)` already encoded the
two rules that matter — `TERMINATE` always escalates regardless of current status, and `HELD` is
sticky against anything but `TERMINATE` — it was simply being evaluated against a *stale* `current`.
The fix restores the missing property: that function is now always evaluated against the session's
*fresh* durable status, read inside the same exclusive SQLite transaction (`BEGIN IMMEDIATE`) that
performs the write, so the whole read-decide-write sequence is atomic and fully serialized against
every other caller — including a second, entirely separate `SentinelRuntime` process sharing the same
SQLite file (proven in the cross-runtime-instance test below), not merely concurrent code within one
process.

Two short-circuits sit in front of `nextStatusForDecision`, in `reconcileDecisionTarget`
(`packages/sentinel-runtime/src/index.ts`):

- **Already terminal** (`TERMINATED`/`COMPLETED`/`INDETERMINATE`): nothing can ever leave a terminal
  status. `isTerminalStatus` already made this true structurally (empty transition lists) — the fix is
  that this check now runs against fresh state instead of throwing from deep inside
  `nextStatusForDecision` on a stale snapshot.
- **Already `TERMINATING`**: another evaluation's termination is either still in flight or has already
  resolved. A second evaluation must never re-claim it — that would risk both a duplicate real
  `containment.terminate()` call and resolving over the first claim's own eventual
  `TERMINATED`/`INDETERMINATE` write.

Both short-circuits resolve to `NO_OP_ALREADY_STRONGER`: no status write, and — critically — **no
containment call is invoked at all** for that decision. This is what makes duplicate destructive
containment structurally impossible rather than merely unlikely: the *claim* (a fast, atomic DB write)
always happens before the real `hold()`/`terminate()` call, so a second racer sees the claim and backs
off before ever touching the containment interface.

### `state_version` and the claim/confirm split

`sentinel_sessions` gained a `state_version INTEGER NOT NULL DEFAULT 0` column (migrated defensively
for a pre-existing v0.1 database via a `PRAGMA table_info` check + `ALTER TABLE`, since `CREATE TABLE
IF NOT EXISTS` does not add columns to an existing table). Every status-changing `UPDATE` is an
explicit compare-and-swap: `SET status = ?, state_version = state_version + 1 ... WHERE state_version =
?`, bound to the version just read in the same transaction. Under `BEGIN IMMEDIATE`'s exclusive lock
this can never actually fail to match — no other writer can have moved `state_version` between the
read and the write of one call — so a failed CAS is treated as an unreachable, honestly-reported
internal error rather than silently retried or swallowed (never fabricate an applied transition). The
version column's real value is auditability: an explicit, monotonic generation counter on every
session row, not merely "the code happens to run inside a transaction."

`applyOutcome` is now a two-phase **claim, then invoke+confirm**:

1. `reconcileAndClaim` — one short exclusive transaction: fresh read, reconcile, CAS write if the
   target is a real change. Returns `{ kind, claimedStatus, priorFreshStatus }`.
2. If `claimedStatus === 'HELD'` and this claim newly entered `HELD` (`priorFreshStatus !== 'HELD'`):
   invoke `containment.hold()` for real, record `CONTAINMENT_CONFIRMED`/`UNCONFIRMED`.
   If `claimedStatus === 'TERMINATING'`: invoke `containment.terminate()` for real, then
   `resolveClaim` — a second short exclusive transaction — moves `TERMINATING` to `TERMINATED`
   (call succeeded) or `INDETERMINATE` (call threw). `resolveClaim` itself re-checks that the
   status is still `TERMINATING` before writing, so it is also a no-op if something else has
   already resolved it (defensive; the short-circuit above should make this unreachable in
   practice for a single claim's own resolution).
   Otherwise (an ordinary bookkeeping transition — e.g. `MONITORING → WARNED`, or an already-`HELD`
   session receiving another `HOLD`-resolving violation): no containment call, `containment_status:
   'NOT_REQUIRED'`.

The decision and its violations are **always** persisted (`persistDecisionAndViolations`), including
for `NO_OP_ALREADY_STRONGER` outcomes — a superseded evaluation's evidence is never silently dropped
merely because a concurrent, stronger decision won the claim (see "Evidence, not deletion" below).

### `resume()` and `completeSession()`

Both were rewritten to the same fresh-read-inside-the-lock discipline as `reconcileAndClaim`, since
they are session-status-changing paths that previously read a snapshot early and wrote late without
re-checking. They are deliberately **not** subject to the "no downgrade" rule that governs automated
decisions above — `resume()`'s entire purpose is to move `HELD` back to `MONITORING`, which is a
downgrade in the automated-decision precedence sense but a legitimate, trusted, operator-directed
action. What they do enforce, via the fresh read: the transition is only legal if the session's
*current* status, checked at write time, is exactly what each method requires (`HELD` for `resume()`;
`MONITORING`/`WARNED` for `completeSession()`) — a session that has concurrently moved past that point
(e.g. into `TERMINATING`) correctly fails with `INVALID_TRANSITION` instead of silently succeeding
against stale information.

### `hold()` / `terminate()` (the public manual-control methods)

Both route through the hardened `applyOutcome` as before. Their leading `loadSession` snapshot is used
only to build the `manualDecision` evidence record (message, timestamps) — never trusted for the
status transition itself, which `reconcileAndClaim` re-derives fresh. The prior version's fast-path
`if (session.status === 'HELD') return session;` in `hold()` is removed: it could itself return a
stale object if the session had moved on since the leading read. The final `loadSession` reload at the
end of both methods always reflects reality.

## Transition matrix (decision type × fresh current status)

| Fresh current status | `CONTINUE` | `WARN` | `HOLD` | `TERMINATE` |
|---|---|---|---|---|
| `MONITORING` | `MONITORING` (self-loop, APPLIED) | `WARNED` (ESCALATED) | `HELD` (ESCALATED) | `TERMINATING` (ESCALATED) |
| `WARNED` | `MONITORING` (APPLIED — legitimate recovery, not a downgrade block) | `WARNED` (self-loop, APPLIED) | `HELD` (ESCALATED) | `TERMINATING` (ESCALATED) |
| `HELD` | `HELD` (sticky, APPLIED) | `HELD` (sticky, APPLIED) | `HELD` (sticky, APPLIED) | `TERMINATING` (ESCALATED — HELD is sticky against everything except TERMINATE) |
| `TERMINATING` | `NO_OP_ALREADY_STRONGER` (short-circuit; no containment call) | same | same | same |
| `TERMINATED` / `COMPLETED` / `INDETERMINATE` | `NO_OP_ALREADY_STRONGER` (short-circuit; no containment call) | same | same | same |

`WARNED → MONITORING` on a `CONTINUE` decision is deliberately *not* blocked as a downgrade: it is the
existing, tested, legitimate recovery path (a warning condition that cleared on a later evaluation),
computed from the session's own fresh state at reconciliation time — not a stale decision overwriting
a newer one. The invariant this closure pass restores is specifically that a decision computed against
an *old* snapshot cannot act on a session that has since moved to a status the decision-maker never
saw, which the terminal/`TERMINATING` short-circuits and `HELD`'s stickiness together cover completely
for every status this runtime can reach.

## Evidence, not deletion

Per the "both violations may be real" principle: a superseded decision (`NO_OP_ALREADY_STRONGER`) is
still written to `sentinel_decisions`, and its violations are still written to `sentinel_violations`.
What is singular is the session's authoritative `status` column — never the evidence trail. This
changed one existing test's expectations (`tests/sentinel/sentinel-runtime.test.ts`, "listViolations
and listDecisions are bounded and paginate via cursor"): five sequential `terminate()` calls on an
already-terminated session now produce five decision records (one `ESCALATED`/`CONTAINMENT_CONFIRMED`,
four `NO_OP_ALREADY_STRONGER`) instead of the prior design's silent early-return that discarded calls
2-5 with no record they occurred. `containment.terminateCalls.length` is still exactly `1` — the real
destructive action's idempotency is unchanged; only the evidence completeness improved.

## Machine-readable transition result

`SentinelDecision` gained `transition_result: 'APPLIED' | 'ESCALATED' | 'NO_OP_ALREADY_STRONGER' |
'STALE'` (`packages/sentinel-engine/src/index.ts`). `evaluateSession` (pure, no visibility into
concurrent durable state) always sets `'APPLIED'`; `SentinelRuntime.applyOutcome` overwrites it with
the real reconciled outcome before persisting. `'STALE'` is reserved for a CAS write that loses a race
after its own precondition read — unreachable under this runtime's locking model (the read and write
for one claim are in the same exclusive transaction), kept as an honestly-reported defensive case
(`INVALID_TRANSITION` thrown, never silently retried or swallowed) rather than a silently-passing
no-op if that invariant were ever violated by a future change.

## Process-boundary honesty

The fix relies on SQLite's own file-level locking (`journal_mode=WAL`, `BEGIN IMMEDIATE`,
`busy_timeout=8000` — all pre-existing configuration, unchanged), not an in-process JS mutex. This
matters because two Sentinel processes could in principle share one SQLite file. Proven directly:
`tests/sentinel/sentinel-concurrency-closure.test.ts`, "two separate SentinelRuntime instances sharing
one SQLite file still resolve a HOLD/TERMINATE race correctly via durable CAS, not JS scheduling" —
two fully independent `SentinelRuntime` objects (separate `DatabaseSync` connections, separate
containment controllers, no shared JS state whatsoever) racing a HOLD against a TERMINATE on the same
session row, both agreeing on the same final `TERMINATED` status afterward.

## What was preserved unchanged

- Observation sequencing, idempotency, and the counter-update transaction inside `submitObservation`
  (already correctly serialized by its own `BEGIN IMMEDIATE`) — untouched.
- Tenant isolation (`(tenant_id, sentinel_session_id)` scoping throughout) — untouched.
- Containment-uncertainty representation (`CONTAINMENT_CONFIRMED`/`UNCONFIRMED`,
  `TERMINATED`/`INDETERMINATE`) — untouched in meaning; now additionally protected from being
  overwritten by a stale concurrent claim (see the HOLD-vs-INDETERMINATE regression test).
- The Ledger adapter, HTTP API, Gate/broker adapters — untouched; no route or adapter signature
  changed.
- All 392 previously-accepted Sentinel tests remain green (one, "listViolations and listDecisions...",
  was *updated* to reflect the intentional evidence-completeness change above — not weakened; it now
  additionally asserts exact cursor pagination across three pages and the 1-confirmed/4-superseded
  decision split, which the prior version never exercised).

## New regression coverage

`tests/sentinel/sentinel-concurrency-closure.test.ts` — 14 tests:

1. BEFORE/AFTER regression (the originally-reported scenario) — HELD slow, TERMINATE fast.
2. Reverse timing — HELD fast, TERMINATE slow.
3. Both delay orderings assert exactly one real `terminate()` call.
4. HOLD vs INDETERMINATE — a stale HOLD must not overwrite an unconfirmed termination.
5. WARN vs HOLD race → HELD, regardless of claim order.
6. WARN vs TERMINATE race → TERMINATED, regardless of claim order.
7. Emergency-stop TERMINATE vs manual HOLD → the stop wins, never HELD.
8. `resume()` fails once a concurrent TERMINATE has already claimed the session.
9. A TERMINATE decision still escalates a session that was already resumed out of HELD.
10. `completeSession()` fails once a concurrent TERMINATE has already claimed the session.
11. Two independent TERMINATE-triggering violations still resolve to one logical containment call and
    a stable terminal status, with both violations retained (pre-existing guarantee, re-asserted).
12. Cross-runtime-instance: two separate `SentinelRuntime`s, one SQLite file.
13. Observation sequencing is unaffected by the closure pass.
14. A sanity check against the project-wide shared test fixture (`setup()`), not just this file's
    locally-constructed runtimes.

## Verification

```
npm run check   # typecheck && lint && build+test
```

Run twice consecutively, no cleanup between runs:

- Run 1: 406 tests, 406 pass, 0 fail (392 pre-existing baseline + 14 new concurrency-closure tests).
- Run 2 (immediately after): 406 tests, 406 pass, 0 fail.

```
npm run demo:sentinel:v01
```

All five pre-existing flows (A–E) still print every required line and exit 0 — unaffected by this
pass; no demo changes were made or needed.

## Mandatory blockers remaining

**0**

## Recommendation

> **READY FOR ARCHITECTURAL ACCEPTANCE REVIEW**

This closure pass does not declare `tna-sentinel-v0.1` accepted and does not tag it. Acceptance
remains the reviewer's call, on top of both `sentinel-v0.1-architectural-review-v1.md` (preserved,
unmodified) and this document.

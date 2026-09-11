# TNA Sentinel Containment Model v0.1

## Interface (section 44)

```ts
interface ContainmentController {
  hold(sessionId: string, reason: ContainmentReason): void | Promise<void>;
  terminate(sessionId: string, reason: ContainmentReason): void | Promise<void>;
}
```

Sentinel never gets arbitrary shell access — this two-method contract is the entire surface. A
`ContainmentReason` carries the triggering `rule_type` (when there is one), a human-readable
`message`, and the `decision_id` it belongs to.

## Fake controller (section 45)

`FakeContainmentController` is the deterministic in-memory adapter used by every test and the demo.
It records every `hold`/`terminate` call (session, reason, timestamp) and exposes
`simulateTerminationFailure(sessionId)` to make the *next* `terminate()` for that session throw,
proving the containment-uncertainty path without needing a real external system.

## Execution-broker adapter — documented limitation (sections 46, 100)

`apps/tna-sentinel/src/broker-containment-adapter.ts`'s `ExecutionBrokerContainmentAdapter`
implements the same interface but always throws. This is not a placeholder oversight: the accepted
`ExecutionBroker.redeem()` runs a tool invocation to completion inside one call with no external
cancellation handle, and `IsolationRunner.run()` is likewise a single run-to-completion `Promise`
with no abort surface. Reaching into either from outside would require modifying already-accepted
code, which this milestone does not do. Rather than fabricate a `hold`/`terminate` that silently does
nothing while claiming success — a direct violation of TNA-30 — the adapter honestly reports
containment as unconfirmed every time, so `SentinelRuntime` correctly resolves to `INDETERMINATE`
rather than a false `TERMINATED`. Real broker/runner termination remains future work; it needs an
abort-signal change to accepted code, out of scope here.

## Idempotency (section 47; revised by the concurrency closure pass — see below)

Calling `terminate()` on an already-`TERMINATED` (or otherwise terminal) session never produces a
second real containment call: `FakeContainmentController.terminateCalls` still records exactly one
entry no matter how many redundant `terminate()` calls are made. What changed in the concurrency
closure pass (`sentinel-v0.1-concurrency-closure.md`) is what happens to the *decision record*: each
call is now honestly persisted as its own decision (`transition_result: NO_OP_ALREADY_STRONGER` for
every call after the first), rather than the original design's silent early return that discarded
calls 2-N with no evidence they were ever made. Three consecutive `terminate()` calls now produce
three decision rows and exactly one containment call — proven in
`tests/sentinel/sentinel-runtime.test.ts` ("explicit terminate() is idempotent") and
`tests/sentinel/sentinel-concurrency-closure.test.ts`.

## HOLD semantics (section 48)

`HOLD` means: stop further privileged progression, preserve runtime/evidence state, and await an
explicit trusted resume or terminate decision. It is never interpreted as success — a HELD session
stays HELD across any number of further `CONTINUE`/`WARN`/`HOLD`-worthy evaluations; only `resume()`
or an escalating `TERMINATE` can move it.

## Resume (section 49)

`resume()` requires a `controller` or `admin` principal, carries an operator `rationale`, and may
rebind `policy_snapshot_hash`/`authority_expiry` to reflect renewed authority. A reader (the closest
thing to a governed agent's own identity in this model) is rejected with `FORBIDDEN` — proven directly
and via the abuse-case and HTTP suites.

## Resolving TERMINATE (sections 54-56; claim/confirm split added by the concurrency closure pass)

`applyOutcome()` in `sentinel-runtime` is the single place a `HOLD`/`TERMINATE` decision is turned
into an actual containment call and a final status. As of the concurrency closure pass, this happens
in two atomic, separately-locked phases rather than one unconditional write — see "Concurrent
Containment Decisions" below for why:

1. **Claim** (`reconcileAndClaim`, a short exclusive SQLite transaction): re-reads the session's
   *fresh* durable status, reconciles the decision's type against it, and — only if the reconciled
   target is a real change — atomically writes that target status. If the session's fresh status is
   already terminal or already `TERMINATING`, this phase is a no-op (`NO_OP_ALREADY_STRONGER`) and
   **no containment call is made at all** for this decision.
2. **Invoke + confirm**: only after a successful claim does the real `containment.hold()` /
   `containment.terminate()` call happen (outside any SQLite transaction, since an external side
   effect cannot be rolled back — section 54's documented boundary, inherited from the accepted Gate
   G3 lesson). For `HOLD`, the claim step already wrote `HELD`; confirm only updates
   `containment_status` (`CONTAINMENT_CONFIRMED` if the call did not throw, `CONTAINMENT_UNCONFIRMED`
   otherwise) — the session stays `HELD` either way, same as before. For `TERMINATE`, a second short
   exclusive transaction (`resolveClaim`) moves the claimed `TERMINATING` status to `TERMINATED` (call
   succeeded) or `INDETERMINATE` (call threw).

The decision and its violations are always persisted (`persistDecisionAndViolations`), in every case
including `NO_OP_ALREADY_STRONGER` — evidence is never dropped merely because this particular
evaluation's outcome was superseded by a stronger one already in effect.

## Never lying about success (TNA-30, section 55)

Because the resolution above is unconditional — every `TERMINATE` decision lands on exactly
`TERMINATED` or `INDETERMINATE`, never anything else — there is no code path that reports a
termination as successful without the containment call itself having not thrown. Proven directly
(`containment failure resolves the session to INDETERMINATE, never falsely TERMINATED`) and via the
demo's Flow E.

## Concurrent Containment Decisions (added by the concurrency closure pass)

Full analysis, the originally-reported failure, and its reproduction:
`sentinel-v0.1-concurrency-closure.md`. Summary of the model:

- **The invariant.** A weaker, stale decision must never overwrite a stronger containment outcome
  already committed or confirmed for the same session. Concretely: once a session is `TERMINATED`,
  `INDETERMINATE`, or `COMPLETED`, nothing can move it anywhere else; once it is `TERMINATING`, no
  second evaluation may re-claim that termination (avoiding a duplicate real `terminate()` call) or
  resolve it to anything other than what the claiming evaluation's own containment call produces;
  `HELD` is sticky against anything but an evaluation that computes `TERMINATE`.
- **Why "stale" was possible at all.** A decision is computed from a session snapshot read at the
  *start* of an evaluation. Evaluating a rule set, and especially invoking an external containment
  call, both take real time. Before this closure pass, the session's final status was written
  unconditionally from that original snapshot's implied target — never re-checked against what might
  have already happened to the session in the meantime.
- **The fix is not last-write-wins, and not a numeric severity table applied blindly.** It is: re-read
  the session's *fresh* durable status inside the same exclusive SQLite transaction that performs the
  write (`BEGIN IMMEDIATE`, which serializes every caller — including two separate `SentinelRuntime`
  processes sharing one SQLite file, not merely concurrent code in one process), and feed that fresh
  status through the *existing*, already-correct `nextStatusForDecision` (TERMINATE always escalates
  regardless of current status; HELD is sticky against anything but TERMINATE) — with two additional
  short-circuits before that function is even consulted: an already-terminal fresh status, or an
  already-`TERMINATING` fresh status, both immediately resolve to `NO_OP_ALREADY_STRONGER` with no
  write and no containment call. A `state_version` column and a `WHERE state_version = ?` clause on
  every status-changing `UPDATE` make this an explicit compare-and-swap, not merely "the code happens
  to run inside a transaction" — the version is bumped on every authoritative transition and gives an
  auditable generation counter, though the SQLite exclusive lock alone already makes the read-decide-
  write sequence atomic within one call.
- **Ordinary lifecycle vs. containment escalation.** Not every status change goes through
  reconciliation. `resume()` and `completeSession()` are deliberate, trusted, human/operator-directed
  transitions, not automated decisions — they use the same fresh-read-inside-the-lock discipline (so
  they correctly fail if the session has concurrently moved past where they expect it), but they are
  not subject to the "no downgrade" rule that governs automated decisions, because moving `HELD` back
  to `MONITORING` is `resume()`'s entire purpose.
- **`transition_result`** (`APPLIED | ESCALATED | NO_OP_ALREADY_STRONGER | STALE`) is recorded on every
  persisted decision, so the evidence trail always shows whether a given evaluation's outcome was the
  one that actually took effect. `STALE` is reserved for a CAS write that loses a race after its own
  precondition read — unreachable under this runtime's locking model, kept as an honestly-reported
  defensive case rather than a silently swallowed failure.
- **What this does not change.** The write-phase transaction inside `submitObservation` (observation
  insert + counter increments) was already correctly serialized by its own `BEGIN IMMEDIATE` and is
  untouched. Observation sequencing, tenant isolation, and the containment-uncertainty model above are
  unaffected — re-proven by the full 392-test baseline plus the new concurrency regression suite.

# TNA Sentinel v0.1 — Architectural Review (Findings)

## Scope and method

Reviewer: Claude (Sonnet 5), acting as reviewer of the implementation agent's
`proof-of-work-sentinel-v0.1.md`, per that document's own closing line ("This implementation agent
does not declare acceptance ... Acceptance belongs to the reviewer.").

Nothing in the proof-of-work document was taken on trust. Every claim below was checked against the
actual working tree at commit `cac0a98956ac1354e3ecc528acff5c0c82ac835d` (Sentinel work uncommitted on
top of it, branch `trust-no-agent-main`), by:

1. Reading all Sentinel source in full — not excerpts: `packages/sentinel-schema/src/index.ts` (293
   lines), `packages/sentinel-policy/src/index.ts` (148), `packages/sentinel-signals/src/index.ts`
   (213), `packages/sentinel-engine/src/index.ts` (168), `packages/sentinel-runtime/src/index.ts`
   (483), and every file under `apps/tna-sentinel/src/` (367 lines across 7 files). 1,672 lines total.
2. Running `npm run check` (typecheck → lint → build+test) myself rather than trusting the recorded
   392/392 result.
3. Running `npm run demo:sentinel:v01` myself and reading its actual output against the five claimed
   flows.
4. Reading the diffs to the three modified accepted files (`README.md`, `apps/tna-ledger/src/
   writers.ts`, `packages/ledger-schema/src/index.ts`) directly with `git diff`, to verify the
   "additive only" claim rather than accepting the doc's characterization of it.
5. Reading `tests/sentinel/sentinel-abuse-cases.test.ts` and `tests/sentinel/sentinel-races.test.ts`
   in full to check the abuse-case and concurrency claims against what is actually asserted.
6. Writing and running an independent reproduction (not part of the committed suite) to test a
   concurrency scenario the existing race tests do not cover — detailed below.

## Claims verified as accurate

- `npm run check`: typecheck PASS, lint PASS, 392/392 tests pass, 0 fail — matches the proof-of-work
  document exactly.
- `npm run demo:sentinel:v01`: all five flows (A–E) printed every required marker line and the process
  exited with `TNA Sentinel v0.1 demo passed.`
- `packages/ledger-schema/src/index.ts`: the diff is exactly what is claimed — `'sentinel'` added to
  `SourceComponent`, ten `SENTINEL_*` values appended to `EVENT_TYPES`. No existing value removed,
  renamed, or reordered.
- `apps/tna-ledger/src/writers.ts`: exactly one new export, `sentinelWriter(tenantId)`. `gateWriter`,
  `vadWriter`, `reader`, `admin` are byte-for-byte unchanged.
- `README.md`: one new section appended (Volume 6 status, marked "in development"), nothing else
  touched.
- Responsibility boundary: `SentinelRuntime` (`packages/sentinel-runtime/src/index.ts`) contains no
  authorization or correctness judgment anywhere in its 483 lines — every decision is a function of
  session-owned bounds, runtime-owned counters/clock, and source-bound observations, as claimed.
- Source-identity fixation: `apps/tna-sentinel/src/writers.ts` hands out exactly the fixed identities
  claimed; `assertCanObserve` (`sentinel-runtime/src/index.ts:29-34`) binds each observer to its
  declared `allowedSources` via `SOURCE_ALLOWED_OBSERVATION_TYPES`, and `sentinel-abuse-cases.test.ts`
  does independently prove impersonation is rejected (source binding, tenant-switch, self-resume,
  forged `decision`/`containment_status` fields all confirmed `FORBIDDEN`/inert as claimed).
- `ExecutionBrokerContainmentAdapter` (`apps/tna-sentinel/src/broker-containment-adapter.ts`): both
  methods are typed `never` and unconditionally `throw` — this is honestly a stub that always signals
  unconfirmed containment, not a fabricated success path, exactly as documented.
- `apps/tna-sentinel/src/main.ts`: credential loading defaults every token to `''` when an env var is
  unset, and `validateCredentials` rejects any token under 32 chars or any duplicate — the server
  cannot start with a blank or reused credential. No hardcoded fallback secret exists.
- HTTP surface: no PATCH/PUT/DELETE route exists for a session — `tests/sentinel/
  sentinel-http.test.ts:226-231` proves all three return 404 against a live session, matching the
  claim.

## Finding: concurrent evaluations with different outcomes can misstate the persisted session status

**Severity: real, reproducible, undocumented. Recommend fixing before acceptance.**

### Root cause

`SentinelRuntime.applyOutcome()` (`packages/sentinel-runtime/src/index.ts:283-304`) is the method that
persists a decision, invokes containment (`hold`/`terminate`), and writes the session's new `status`.
Its final write is:

```ts
this.db.prepare('UPDATE sentinel_sessions SET status = ?, updated_at = ? WHERE tenant_id = ? AND sentinel_session_id = ?')
  .run(finalStatus, now, session.tenant_id, session.sentinel_session_id);
```

This `UPDATE` is unconditional: it does not check the row's *current* status, does not use a
compare-and-swap (`WHERE status = <expected prior status>`), and `assertValidTransition` two lines
above it (`line 284`) is checked against the **stale, in-memory `session` object passed into
`applyOutcome`**, not a fresh read of the row under the transaction's lock. Two independent evaluations
of the same session (a manual `hold()` call racing an observation that triggers a rule-based
`TERMINATE`, for example) each compute their own outcome from their own stale snapshot, each invoke
their own containment call for real, and then each write `status` — whichever write commits *last*
wins, regardless of severity or of which containment call actually fired.

This is architecturally distinct from — and not covered by — the concurrency guarantee the proof
document does substantiate: the write-phase transaction inside `submitObservation` (observation insert
+ counter update) *is* correctly serialized by SQLite's `BEGIN IMMEDIATE` exclusive lock, which is why
"10 concurrent observations → 10 unique sequence numbers" holds. `applyOutcome` runs in a **separate,
later** transaction (necessarily, since containment calls are async and can't run inside a synchronous
SQLite transaction), and that second transaction has no such protection.

`sentinel-races.test.ts`'s "concurrent terminating violations" test does not catch this because both
racing observations in that test compute the *same* decision (`TERMINATE`); last-write-wins is
invisible when both writers agree. It was not caught by `sentinel-abuse-cases.test.ts`,
`sentinel-http.test.ts`, or any test in the 392-test suite. It is not mentioned in
`sentinel-containment-model-v0.1.md` or `sentinel-threat-model-v0.1.md` as a known limitation.

### Reproduction

Script (run against the built `dist/`, not committed to `tests/sentinel/`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SentinelRuntime, observerPrincipal, controllerPrincipal, adminPrincipal } from './dist/packages/sentinel-runtime/src/index.js';
import { defaultDemoPolicyInput } from './dist/packages/sentinel-policy/src/index.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// A containment controller where hold() is slow and terminate() is fast, to force a specific
// DB-write interleaving: the TERMINATE decision's status update should commit BEFORE the HOLD
// decision's status update lands.
class DelayedContainmentController {
  holdCalls = []; terminateCalls = [];
  async hold(sessionId, reason) { await sleep(150); this.holdCalls.push({ sessionId, reason }); }
  async terminate(sessionId, reason) { this.terminateCalls.push({ sessionId, reason }); }
}

test('mixed-decision concurrent evaluations', async () => {
  const containment = new DelayedContainmentController();
  const runtime = new SentinelRuntime('./scratch-race.sqlite', { containment });
  const tenantId = 't1';
  const admin = adminPrincipal('a', tenantId), ctrl = controllerPrincipal('c', tenantId);
  const bw = observerPrincipal('bw', tenantId, ['EXECUTION_BROKER']);
  runtime.setPolicy(admin, defaultDemoPolicyInput(tenantId));
  const session = runtime.createSession(ctrl, {
    version: '1.0', tenant_id: tenantId, agent_id: 'agent1', execution_id: 'exec1', correlation_id: 'corr1',
    authority_snapshot_hash: 'a'.repeat(64), policy_snapshot_hash: 'b'.repeat(64),
    expected_action: 'deploy', expected_tool: 'github', expected_resource: 'repo:x',
    allowed_destinations: ['api.github.com'], allowed_operations: ['read'],
    authority_expiry: new Date(Date.now() + 3600_000).toISOString(),
    runtime_limits: { max_runtime_seconds: 3600 }, cost_limits: { max_cost_usd: 10 },
  });

  // Fired "concurrently": a manual HOLD (slow containment confirmation) racing a tool-drift
  // TERMINATE (fast containment confirmation) on the very same session.
  const holdPromise = runtime.hold(ctrl, session.sentinel_session_id, 'manual hold race');
  const terminatePromise = runtime.submitObservation(bw, session.sentinel_session_id, {
    version: '1.0', observation_id: 'race-term', tenant_id: tenantId, sentinel_session_id: session.sentinel_session_id,
    timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' },
  });
  await Promise.allSettled([holdPromise, terminatePromise]);

  const finalSession = runtime.getSession(ctrl, session.sentinel_session_id);
  assert.equal(containment.terminateCalls.length, 1);
  assert.equal(containment.holdCalls.length, 1);
  console.log('FINAL PERSISTED SESSION STATUS:', finalSession.status);
  runtime.close();
});
```

Observed output (two independent runs, `node --test race-repro.test.mjs`, `2026-09-11T08:10Z`):

```
hold() call resolved with session status: HELD
submitObservation resolved with decision: TERMINATE
FINAL PERSISTED SESSION STATUS: HELD
containment.hold() invocations: 1 | containment.terminate() invocations: 1
=> MISMATCH: real containment.terminate() fired, but persisted status is "HELD" -- the record no
   longer reflects that the session was actually terminated.
✔ mixed-decision concurrent evaluations (230.5ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

`containment.terminate()` was invoked exactly once — in a real deployment this is the call that tells
the execution broker/isolation runner to stop the agent. `containment.hold()` was also invoked once,
independently, for the same session. Both real-world side effects happened. But `runtime.getSession()`
afterward reports `status: 'HELD'`, because the HOLD evaluation's status write landed after the
TERMINATE evaluation's.

### Why this matters

This contradicts two specific claims in `proof-of-work-sentinel-v0.1.md`:

- "Explicit `terminate()` and rule-triggered TERMINATE both resolve to exactly `TERMINATED`
  (confirmed) or `INDETERMINATE` (unconfirmed) — never anything else." — Demonstrated false under this
  race: the session resolves to `HELD`, a third outcome not in that list, despite `terminate()` having
  been genuinely invoked and having genuinely not thrown.
- "Two concurrent terminating violations on one session → one stable final state (`TERMINATED`)" — true
  only for the same-decision case that is actually tested; false in general.

The practical risk: a controller/operator reading `session.status === 'HELD'` has a documented,
trusted path to call `resume()` on a HELD session (`sentinel-runtime/src/index.ts:329-342`, controller/
admin only). If the underlying containment layer already terminated the agent for real, `resume()`
would rebind the session to `MONITORING` for an agent execution that may no longer exist — a
misleading operational state at exactly the boundary (containment truth vs. recorded truth) Sentinel
exists to keep honest.

## Recommendation

**Do not tag `tna-sentinel-v0.1` on the current working tree.** Before acceptance, either:

1. Fix `applyOutcome` so a session's status transition is conditioned on the row's status at write
   time (e.g. `UPDATE ... WHERE status = ?` bound to the status the decision was computed against,
   with the caller re-deriving/re-escalating on a no-op update), or serialize evaluation per session
   so a second evaluation cannot start from a stale snapshot while the first is still resolving
   containment; and add a regression test that races two *different* decisions (not two identical
   ones) against the same session; or
2. If a fix is deferred, document this explicitly as a known limitation in
   `sentinel-containment-model-v0.1.md` and the threat model, and correct the two proof-of-work claims
   above so they no longer assert a guarantee that does not hold — acceptance can proceed on a
   documented gap, but not on an inaccurate claim.

Everything else reviewed checks out against the actual code and actual command output, not just the
document's own description of itself.

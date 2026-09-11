# TNA Sentinel v0.1 Verification

## Command

```bash
npm run check   # typecheck && lint && build+test
```

Run twice consecutively, no manual cleanup between runs (section 123).

## Observed Output — Run 1

- Typecheck: PASS
- Lint: PASS
- Build: PASS
- Total tests: 392
- Passed: 392
- Failed: 0

## Observed Output — Run 2 (immediately after, no cleanup)

- Total tests: 392
- Passed: 392
- Failed: 0

## A transient, pre-existing flake observed and re-verified away

During this session's iteration, one `node --test` run of the full compiled suite (outside the two
official consecutive `npm run check` runs recorded above) showed a single failure:
`file evidence store concurrent identical writers succeed and conflicting writers have one winner`
(`tests/vad/vad-engine.test.ts`, part of the accepted VAD Engine v0.1 baseline). This test does real
concurrent filesystem I/O with 12 parallel writers; adding fourteen new Sentinel test files increased
the number of files `node --test` runs concurrently, which increased system-level I/O contention
during that one run. It was re-run in isolation four times (all pass) and the full suite was re-run
three more times afterward (all 392/392) — including the two official back-to-back `npm run check`
runs recorded above, both clean. Nothing in this milestone's code touches `packages/evidence-core` or
`tests/vad/vad-engine.test.ts`; the test's own logic and the accepted VAD Engine v0.1 code are
unmodified. Recorded here rather than silently omitted, per this project's failing-first discipline.

## Reconciliation against the accepted baseline

The baseline going into Volume 6 was 250 tests (163 Gate/VAD + 56 core Ledger + 8 bounded-stream +
23 HTTP integration, per the accepted `tna-ledger-v0.1` state and its subsequent closure pass). This
milestone adds 142 Sentinel tests across ten files in `tests/sentinel/`. 250 + 142 = 392, matching the
Node test runner's reported total exactly — no estimation.

## Demo

```bash
npm run demo:sentinel:v01
```

Ran all five required flows (A: normal, B: tool drift, C: revocation mid-run, D: policy drift
hold/resume, E: containment failure) with every required output line present, exit code 0.

## Failing-first examples

Two real defects were caught while building this milestone's tests, not asserted fixed without
re-running:

1. **A hardcoded past `authority_expiry` in the HTTP test fixture.** The unit/runtime test fixture
   (`tests/sentinel/fixture.ts`) uses an injected fixed clock, so a literal `2026-01-01T01:00:00.000Z`
   authority expiry was always in that fixture's future. The HTTP integration harness
   (`tests/sentinel/sentinel-http.test.ts`) intentionally uses the real system clock (to exercise the
   actual server's default behavior), and by the time this milestone was built the real date had
   passed that literal — every session created via HTTP was immediately `AUTHORITY_EXPIRED`, so the
   "bound observer can submit an allowed observation" test asserted `CONTINUE` but observed
   `TERMINATE`, and two other HTTP tests failed as a direct consequence (a tool-drift test picked up
   `AUTHORITY_EXPIRED` as the first violation instead of `TOOL_NOT_ALLOWED`, and a pagination test saw
   only 1 decision instead of 2 because the session had already gone terminal). Fixed by computing
   `authority_expiry` as `now + 1 hour` in that one fixture function. This was a test-fixture defect,
   not a Sentinel implementation defect — but it was caught by actually running the HTTP suite rather
   than assuming it would pass, exactly the discipline section 110 asks for.
2. **A test helper silently hardcoded session counters to zero.** An early draft of
   `tests/sentinel/sentinel-engine.test.ts`'s local `session()` builder wrote
   `tool_call_count: 0, ...` literally instead of reading the values passed as test overrides. Two
   tests that depended on a nonzero `tool_call_count` ("decision precedence" and "risk_thresholds
   escalate") failed with results consistent with the counter always being zero. Fixed by reading each
   counter from the override object with a `?? 0` fallback. Also a test-fixture defect, caught by
   running the tests rather than trusting the code that had been written.

Both were root-caused by comparing expected vs. actual failure output, not by inspection alone.

## Meta-evidence

392 passing tests establish that the implemented behaviors pass their own checks. As with the
accepted Ledger milestone, this does not by itself certify every Volume 6 requirement is implemented
to the letter — v0.1 targets the accountability-critical subset (deterministic rule evaluation,
runtime-owned sequencing/counters/clock, source binding, containment idempotency and honesty,
emergency stop, tenant isolation, Ledger integration) rather than every numbered item verbatim. The
requirement matrix and threat model are the honest accounting of what is and is not covered.

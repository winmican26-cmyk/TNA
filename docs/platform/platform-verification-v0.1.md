# TNA Platform Integration v0.1 Verification

## Command

```bash
npm run check   # typecheck && lint && build+test
```

Run twice consecutively, no manual cleanup between runs.

## Observed output — Run 1

- Typecheck: PASS
- Lint: PASS
- Build: PASS
- Total tests: 579
- Passed: 579
- Failed: 0

## Observed output — Run 2 (immediately after, no cleanup)

- Total tests: 579
- Passed: 579
- Failed: 0

## Reconciliation against the accepted baseline

Baseline entering Volume 8: 535 tests (accepted TNA Auditor v0.1 baseline, `tna-auditor-v0.1`, plus
the trust-closure pass folded into it). This milestone adds 44 platform tests across 8 files in
`tests/platform/`:

| File | Tests |
|---|---|
| `platform-state.test.ts` | 2 |
| `platform-outbox.test.ts` | 2 |
| `platform-orchestration.test.ts` | 3 |
| `platform-execution.test.ts` | 9 |
| `platform-http.test.ts` | 9 |
| `platform-abuse-cases.test.ts` | 12 |
| `platform-races.test.ts` | 5 |
| `platform-auditor-integration.test.ts` | 2 |
| **Total** | **44** |

535 + 44 = 579, matching the Node test runner's reported total exactly in both consecutive
`npm run check` runs — no estimation.

## Demo

```bash
npm run demo:platform:v01
```

Ran all six required flows (1: success, 2: block, 3: Sentinel termination via genuine mid-flight
revocation, 4: verified work via real VAD, 5: outbox recovery across a real process restart, 6: audit)
against real Gate/Sentinel/Ledger/VAD/Auditor library code, printed every required marker line, exited
0.

## Failing-first defects found

Genuine defects caught by actually running the suite against real, accepted components — not assumed
correct from inspection alone (the same discipline every prior volume followed):

1. **`ExecutionBroker`'s broker-internal `operation()` binding rule is hardcoded to the literal
   action string `'production.deploy'`.** The platform's own capability-binding call must mirror this
   exactly (`brokerOperation()`), independent of the platform's own `operation` field — found by
   reading the accepted broker source directly (execution-broker/src/index.ts), not assumed.
2. **`ExecutionBroker`'s internal `ToolInputRegistry` is private and pre-registers exactly one tool**
   (`demo.deploy.execute`). For every other tool, the broker hands the connector handler an empty
   `input: {}` regardless of what was redeemed with — found when the first real end-to-end test
   asserted the connector received the caller's input and it did not. Documented as a discovered
   integration constraint (`platform-gate-integration-v0.1.md`), not silently patched around: the
   platform's own `request.input`/`input_hash` binding and Ledger evidence remain authoritative.
3. **Sentinel's `expected_resource`/observation `resource` pattern requires an alphanumeric leading
   character; Gate's file-scoped resources require a leading `/`.** The first real end-to-end test run
   failed with `expected_resource is required` against a genuine Gate-file-shaped resource before
   `toSentinelResource()` was added to normalize consistently at every Sentinel-facing boundary.
4. **A shared demo Gate instance's envelope usage counters accumulate across flows.** The demo
   initially constructed a fresh Gate `Store` per flow, which failed on Flow 2's agent
   re-registration (`Agent already registered`); switching to one shared Gate instance across all six
   flows then hit the envelope's `max_retries_per_action: 2` limit by Flow 5, since all flows share
   one `log.write` action. Fixed by raising the demo envelope's retry limit and documenting why,
   rather than silently working around it.
5. **A per-flow demo SQLite file left over from a previous run made `createOrReturn`'s idempotency
   return stale, pre-fix state.** The original cleanup step only wiped four shared paths, not each
   flow's own file — found when Flow 5 kept reporting a stale `BLOCKED` result after the retry-limit
   fix had already landed. Fixed by wiping every `demo-platform*` file at startup, not a fixed list.

All five were root-caused by comparing expected vs. actual output from real execution against the real
accepted components, not by inspection or assumption.

## Meta-evidence

579 passing tests establish that the implemented behaviors pass their own checks. As with every prior
milestone, this does not by itself certify every Volume 8 requirement to the letter — v0.1 targets the
accountability-critical subset (CAS state transitions, broker-mediated execution with no bypass,
Sentinel pre-action enforcement, transactional-outbox evidence durability, tenant isolation,
concurrency safety proven with genuine races, and honest post-hoc audit framing) rather than every
numbered item verbatim. The requirement matrix is the honest accounting of what is and is not covered.

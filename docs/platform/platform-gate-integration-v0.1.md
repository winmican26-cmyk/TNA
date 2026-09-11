# TNA Platform — Gate Integration v0.1

## `GateActionAdapter` (section 14)

```ts
interface GatePort {
  authorize(principal: {kind:'agent'; agentId:string}, request: {agentId, action, tool, resource, estimatedCostUsd, destination?}): GateDecisionLike;
}
class GateActionAdapter implements GatePort { constructor(gate: Gate) {} }
```

`PlatformActionRequest -> GateActionAdapter -> Authority Envelope / Decision`, exactly as section 14
specifies. `GateActionAdapter` calls only Gate's own public `authorize()` — no Gate behavior is
modified, reimplemented, or bypassed. Gate's `Gate` class lives inside `apps/tna-gate-api` (not a
package, unlike Sentinel/VAD/Ledger/Auditor's own engines), so this is the one place the platform
needs an explicit adapter rather than a direct package import.

## Store ownership (section 52)

The platform constructs its **own** `Gate`, `Store` (evidence-core), and `ExecutionBroker` instances,
bound to `data/tna-platform-gate.sqlite` — a separate file from the standalone `tna-gate-api` app's
own database. `ExecutionBroker.issue()` reads a `Decision` by id from the *same* `Store` `Gate.authorize()`
wrote it to, which is why the broker must share Gate's store, not a copy.

## BLOCK / HOLD paths (sections 15-16)

If Gate returns `BLOCK` or `HOLD`, `PlatformGateOrchestrator.recordGateDecision` moves the action to
`BLOCKED`/`HELD` in the same transaction that records the decision — `PlatformExecutionOrchestrator`
is never invoked (there is no code path from `BLOCKED`/`HELD` into `CAPABILITY_ISSUED`/`MONITORING` —
see `platform-state-machine-v0.1.md`'s transition table). Proven directly: `platform-orchestration.test.ts`
and `platform-http.test.ts` assert zero `PLATFORM_EXECUTION_CLAIMED` outbox records and zero connector
calls for both outcomes.

## Capability binding (section 18) and a discovered integration constraint

Capability issuance/redemption uses Gate's real, accepted `ExecutionBroker`/`CapabilityCodec`/
`ToolRegistry` — the platform never bypasses it. Two internal conventions of that accepted broker are
worth recording precisely, since they are easy to mis-assume:

- `ExecutionBroker`'s private `operation()` method hardcodes capability/redeem binding to `'write'`
  for the literal action string `'production.deploy'` and `'read'` for every other action, regardless
  of the platform's own `operation` field. The platform's `brokerOperation()` helper mirrors this
  exactly (`packages/platform-core`) so capability binding stays valid; it has no other effect on the
  platform's own `operation` semantics (used for Sentinel's `allowed_operations`, independently).
- **Failing-first defect found during verification**: `ExecutionBroker`'s internal `ToolInputRegistry`
  is private and pre-registers exactly one tool (`demo.deploy.execute`). For every other tool —
  including every platform connector — the broker hands the handler an empty `input: {}` regardless
  of what was redeemed with; the caller-supplied `input` never reaches the connector through the
  broker's own handler context. This was caught directly (`platform-execution.test.ts`'s end-to-end
  test initially asserted the wrong thing and failed against the real broker). It does not create a
  gap: the platform's own `request.input` — bound via `input_hash` independently of the broker
  (section 19) — and the Ledger evidence trail remain the authoritative record of what was requested;
  only the broker's own handler-visible payload is affected. A production connector that genuinely
  needs its real input inside the handler would need Gate's own `ToolInputRegistry` extended for that
  tool — out of scope for this milestone, since that registry is accepted, closed code.

## Input-mutation defense (section 19)

`computeInputHash` binds `(tool, operation, resource, input)` once at `RECEIVED`; the orchestrator
re-derives and compares it immediately before every `redeem()` call. Structurally unreachable through
the public API (the stored request never changes), proven directly by a white-box test that corrupts
the stored row and asserts the connector is never invoked.

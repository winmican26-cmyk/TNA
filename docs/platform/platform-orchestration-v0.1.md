# TNA Platform Orchestration v0.1

## The facade (section 45)

```ts
class PlatformFacade {
  async submitAndRun(principal: PlatformPrincipal, raw: unknown, createdBy: string): Promise<PlatformAction>
}
```

"Create + orchestrate through a bounded request" (section 45's own recommendation): one call drives
an action from `RECEIVED` to a terminal or `HELD` state within one bounded synchronous HTTP request.
This is the single place the create → authorize → execute sequence lives — both
`POST /v1/platform/actions` and the demo script call it, so the sequencing is never duplicated.

Idempotent: if `createOrReturn` finds the `request_id` already progressed past `RECEIVED` (a replay of
an already-handled submission), the facade returns the current action as-is rather than re-running any
side effect.

## `PlatformGateOrchestrator` — the authorization leg

```ts
class PlatformGateOrchestrator {
  authorize(principal: PlatformPrincipal, actionId: string): PlatformAction
}
```

`RECEIVED -> AUTHORIZING -> {AUTHORIZED | BLOCKED | HELD}`. Calls exactly one method —
`GatePort.authorize()` — and records the *exact* decision (`decision_id`, `decision`, `reason`,
`policy_hash`, `policy_version`, `approval_reference`, `decided_at`) atomically with the state
transition. See `platform-gate-integration-v0.1.md`.

## `PlatformExecutionOrchestrator` — the capability/Sentinel/execution/verification leg

```ts
class PlatformExecutionOrchestrator {
  async run(principal: PlatformPrincipal, actionId: string): Promise<{ action: PlatformAction; executed: boolean }>
}
```

Only callable from `AUTHORIZED`. In order:

1. **Capability issuance** (`AUTHORIZED -> CAPABILITY_ISSUED`) — `ExecutionBroker.issue()`, Gate's own
   accepted capability mediation. A failure fails closed to `FAILED`/`CAPABILITY_FAILURE`.
2. **Sentinel session creation** (`CAPABILITY_ISSUED -> MONITORING`) — a failure here fails closed to
   `INDETERMINATE`/`SENTINEL_UNAVAILABLE`; execution never proceeds unmonitored (section 21).
3. **Durable execution claim** (`MONITORING -> EXECUTING`) — the CAS-protected one-winner claim.
4. **Mandatory pre-action Sentinel check** (section 23) — a `TOOL_CALL_REQUESTED` observation is
   submitted and evaluated *before* the connector is ever invoked. `TERMINATE` or `HOLD` here means
   `executed: false` — the connector is provably never called (see `platform-sentinel-integration-v0.1.md`).
5. **Input-binding re-verification** (section 19) — see `platform-action-spec-v1.md`.
6. **Broker-mediated connector execution** — `ExecutionBroker.redeem()`, never a direct handler call.
7. **Optional VAD verification** (`requires_verification: true`) — `VERIFYING -> {COMPLETED|FAILED|INDETERMINATE}`
   via `VadPort.verify()`. `requires_verification: true` with no configured `VadPort` is itself
   `INDETERMINATE`, never a silent skip (section 27, 30).

## `PlatformControlOrchestrator` — operator actions (sections 47-48)

```ts
class PlatformControlOrchestrator {
  resume(principal: PlatformPrincipal, actionId: string): PlatformAction    // HELD -> AUTHORIZING
  terminate(principal: PlatformPrincipal, actionId: string, reason: string): PlatformAction
}
```

Both require `platform-operator` or `platform-admin` — `platform-schema`'s own role guard rejects an
agent principal before either method's body runs, so "agent cannot self-approve/self-resume/self-terminate"
holds structurally, not by convention (proven in `platform-abuse-cases.test.ts` and `platform-http.test.ts`).

## `reconstructPlatformAction` — the standing answer to section 148's question

```ts
function reconstructPlatformAction(store: PlatformStore, tenantId: string, actionId: string): PlatformActionReconstruction
```

Builds, from durable state alone, the full CONTROL → EVIDENCE → EVALUATION → RESULT chain for one
action: identity, the exact Gate decision, capability/Sentinel-session ids, execution/verification
evidence, outbox delivery status (`OK`/`DEGRADED`), final state, and error detail if any. This is what
`GET /v1/platform/actions/:id/evidence` returns, and what the demo prints as "ACTION RECONSTRUCTED."

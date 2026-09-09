# Execution Broker

## Status and boundary

The execution broker is **implemented** in `packages/execution-broker` and wired to the Vol 2 HTTP API. It is a trusted server-side mediator. The governed agent can request authorization and redeem a capability, but it cannot invoke a registered handler directly. The demo handler is **simulated**: it writes a JSON artifact below a temporary local sandbox and performs no network or production action.

## Flow

1. The agent submits `POST /v1/authorize`.
2. Gate validates identity, envelope, action binding, resource, destination, limits, approval, expiry, and revocation.
3. Only `ALLOW` can reach `POST /v1/capabilities`; `BLOCK` and `HOLD` are rejected.
4. The broker verifies the stored decision, current policy/revision, revocation state, and registered-tool compatibility, then issues one short-lived capability.
5. `POST /v1/capabilities/redeem` verifies the HMAC and exact action/tool/resource/operation/destination binding.
6. In one SQLite transaction, the capability is marked consumed and `STARTED` evidence is committed before invoking the trusted handler.
7. The handler result is reduced to a hash and `SUCCEEDED` or `FAILED` evidence is appended. Raw tool output is not returned or persisted.

## States

The append-only execution transition vocabulary is:

`REQUESTED -> AUTHORIZED -> CAPABILITY_ISSUED -> STARTED -> SUCCEEDED | FAILED`

A rejected issuance or redemption records `BLOCKED`. `STARTED` means the capability was consumed and invocation was authorized; it is not a claim that an external action completed. The broker never silently turns a failed persistence operation into success.

## Registry

`ToolRegistry` is server-owned. Registry metadata exposes name, action, resource type, allowed operations, network requirement, and declared credential names, but never exposes handlers. `ToolRegistry.invoke` is deliberately broker-only and rejects direct use. `createDemoRegistry` registers `demo.deploy.execute` for `production.deploy`, infrastructure/write, no network, and no credentials. Production adapters are not part of this milestone.

Routes are:

| Method | Route | Purpose |
|---|---|---|
| POST | `/v1/capabilities` | Issue for one stored `ALLOW` decision |
| POST | `/v1/capabilities/redeem` | Redeem and invoke a compatible registered tool |
| GET | `/v1/executions/:id` | Read an execution owned by the agent or administrator |
| GET | `/v1/agents/:id/executions` | Read executions subject to identity checks |

There is intentionally no `/v1/tools/:name`, generic handler route, or agent-supplied executable callback. Unknown routes return HTTP 404. Missing broker configuration returns HTTP 503 and does not authorize execution.

## SQLite and side effects

SQLite transactions make decision reservations, capability consumption, and evidence durable, but they cannot atomically include an external side effect. The broker commits `STARTED` before the handler. If the handler fails, it records `FAILED`; if recording the outcome fails after the handler ran, the capability remains consumed and the response is unavailable/indeterminate rather than replayable. The current demo handler writes a local artifact after `STARTED`; the artifact directory is removed by the demo cleanup.

This boundary is **implemented and explicit**, not solved: a production adapter needs idempotency, reconciliation, durable external evidence, and operator handling for indeterminate outcomes.

# TNA Platform Integration v0.1 — Overview

## What this is

TNA Platform Integration v0.1 is not a sixth security product. The five accepted products —
Gate, VAD Engine, Ledger, Sentinel, Auditor — already exist and are independently accepted. This
milestone turns them into one usable system: a client sends one governed action into TNA and that
action moves through authorization, capability issuance, monitored execution, evidence recording,
optional VAD verification, and — after the fact — governance assessment, without the caller manually
coordinating five separate subsystems.

## The end-to-end flow

```
CLIENT
  → PlatformActionRequest v1.0
  → Gate (authorize)          — ALLOW / BLOCK / HOLD
  → Capability issuance       — Gate's ExecutionBroker, same accepted mediation
  → Sentinel session + pre-action check
  → Broker-mediated connector execution
  → (optional) VAD verification
  → Ledger evidence (transactional outbox)
  → (post-hoc, optional) Auditor assessment
```

## Responsibility boundary (unchanged)

- **Gate** decides authorization and mediates capability-bound execution. The platform never calls a
  connector directly — every consequential side effect flows through Gate's own accepted
  `ExecutionBroker`.
- **Sentinel** evaluates runtime behavior and owns containment. The platform never executes
  containment itself — it submits observations and honors Sentinel's decision.
- **Ledger** is the evidence backbone. The platform never claims delivery without durable proof — see
  `platform-outbox-v0.1.md`.
- **VAD** verifies produced work when required. The platform never fabricates a verdict — see
  `platform-vad-integration-v0.1.md`.
- **Auditor** assesses governance controls after the fact. It is never in the critical execution
  path, and its outcome never rewrites the platform's own recorded execution result (TNA-47).

The platform orchestrates. It does not replace any of the above (TNA-43).

## Architecture

```
packages/
  platform-schema/      request/state/principal types, validation, canonicalization
  platform-outbox/      transactional outbox record shape, backoff/dead-letter policy, dispatcher
  platform-connectors/  ToolConnector interface, trusted registry, demo connector, MCP boundary type
  platform-core/        PlatformStore (durable CAS state machine), orchestrators, Ledger dispatcher

apps/
  tna-platform/         GateActionAdapter, VadVerificationAdapter, connector→ToolRegistry wiring,
                         HTTP API, composition root (main.ts)
```

`platform-core` imports Gate/Sentinel/VAD/Ledger/Auditor's own accepted library classes directly
where they are real packages (Sentinel, VAD, Ledger, Auditor); Gate's top-level `Gate` class lives
inside `apps/tna-gate-api`, so the platform talks to it through a narrow `GatePort` interface
(`GateActionAdapter` in `apps/tna-platform`) — the one explicit adapter section 14 of the brief asks
for. No accepted component's internal logic was modified, merged, or reimplemented.

## Status

**In development — not yet accepted.** See `proof-of-work-platform-v0.1.md` and
`platform-threat-model-v0.1.md` before relying on this milestone.

## Documentation set

- `platform-action-spec-v1.md` — the request/action data model.
- `platform-state-machine-v0.1.md` — the 13-state lifecycle and CAS discipline.
- `platform-orchestration-v0.1.md` — how the pieces are sequenced end to end.
- `platform-gate-integration-v0.1.md`, `platform-sentinel-integration-v0.1.md`,
  `platform-vad-integration-v0.1.md`, `platform-ledger-integration-v0.1.md` — per-component adapters.
- `platform-outbox-v0.1.md` — the transactional outbox.
- `platform-auditor-integration-v0.1.md` — post-hoc governance assessment.
- `platform-connector-model-v0.1.md`, `platform-mcp-boundary-v0.1.md` — the tool surface.
- `platform-threat-model-v0.1.md` — what is and is not mitigated.
- `platform-verification-v0.1.md` — test/check/demo evidence.
- `platform-requirement-matrix-v0.1.md` — item-by-item scoring.
- `proof-of-work-platform-v0.1.md` — the full submission record.

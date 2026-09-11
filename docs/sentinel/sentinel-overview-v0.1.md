# TNA Sentinel v0.1 Overview

## Purpose

TNA Sentinel is the runtime behavioral defense and containment layer of Trust No Agent. It answers,
continuously, while an authorized activity is under way:

> Even if an action was authorized, is the agent still behaving within the authority, behavioral
> boundaries, execution expectations, and risk limits that made that authorization acceptable?

## Responsibility boundary

```
TNA GATE       = MAY THE ACTION BEGIN?
VAD ENGINE     = DID PRODUCED WORK SATISFY ITS SPECIFICATION?
TNA LEDGER     = WHAT HAPPENED AND WHAT EVIDENCE EXISTS?
TNA SENTINEL   = IS RUNTIME BEHAVIOR STILL WITHIN SAFE AND AUTHORIZED BOUNDS?
```

Sentinel does not decide whether an action may begin (Gate), does not judge whether produced work is
correct (VAD), and does not itself constitute the evidence record (Ledger — Sentinel writes into it
through a dedicated adapter, the same way Gate and VAD evidence flows into it). Sentinel owns exactly
one question: whether *observed runtime behavior* is still consistent with what was authorized.

## The pipeline

```
AUTHORIZED ACTIVITY → OBSERVATION → NORMALIZATION → BEHAVIOR RULE EVALUATION → RISK SIGNALS →
DETERMINISTIC SENTINEL DECISION → CONTINUE / WARN / HOLD / TERMINATE → EVIDENCE TO TNA LEDGER
```

## Package layout

Five packages plus one app, matching the milestone's recommended structure with no decorative
micro-packages:

- **sentinel-schema** — session/observation input shape, controlled enums (session status,
  observation source/type, rule type, severity, decision type, authority status), canonicalization,
  hashing, secret rejection. No I/O.
- **sentinel-policy** — Sentinel's own behavioral policy (rule catalog, severity/action per rule
  type, volumetric thresholds), hash computation, the safe default demo policy. Distinct from — and
  unaware of — any tenant's Gate authorization envelope.
- **sentinel-signals** — normalization (hostnames, process names) and the twenty deterministic,
  side-effect-free per-rule-type evaluators.
- **sentinel-engine** — folds rule results into one decision (precedence, risk score, violations) and
  owns the session state machine. Pure and deterministic — no I/O, no containment calls.
- **sentinel-runtime** — the durable SQLite store and the `SentinelRuntime` facade: principals/roles,
  runtime-owned sequencing and counters, the observation pipeline, containment invocation, emergency
  stop.
- **apps/tna-sentinel** — fixed writer identities, the Gate authority-revalidation adapter, the
  execution-broker containment adapter (and its documented limitation), the Sentinel→Ledger adapter,
  the HTTP API, and the process entrypoint.

## What v0.1 does not build

No LLM-based behavioral scoring, no semantic intent interpretation, no neural anomaly detection, no
SIEM/EDR/kernel-sandboxing replacement, no SOC dashboard, no enterprise policy editor UI, no Auditor,
no cross-organization fleet management, no autonomous self-healing, no blockchain. See
`sentinel-threat-model-v0.1.md` for what is and is not mitigated, and the proof of work for the exact
scope boundary.

## Documentation set

- `sentinel-session-spec-v1.md` — the runtime session model and state machine.
- `sentinel-observation-spec-v1.md` — the observation model, source binding, sequencing.
- `sentinel-policy-spec-v1.md` — the policy schema, hashing, session/policy field boundary.
- `sentinel-rule-catalog-v0.1.md` — every rule type: what triggers it, what evidence it produces.
- `sentinel-decision-model-v0.1.md` — precedence, risk score, prevention status.
- `sentinel-containment-model-v0.1.md` — the containment interface, idempotency, uncertainty.
- `sentinel-ledger-integration-v0.1.md` — the Ledger schema extension and event mapping.
- `sentinel-threat-model-v0.1.md` — threat coverage and explicit non-mitigations.
- `sentinel-verification-v0.1.md` — verification runs and failing-first defects.
- `sentinel-requirement-matrix-v0.1.md` — item-by-item scoring.
- `proof-of-work-sentinel-v0.1.md` — the full closure proof.

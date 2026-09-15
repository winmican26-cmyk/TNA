# TNA Deployment Example — Critical Infrastructure

## Scope

Applicable environments may include:

- energy;
- water;
- telecommunications;
- transport;
- industrial systems;
- data centers;
- operational technology.

These environments require particularly conservative integration.

## Architecture

```text
AI Operations Agent
    ↓
TNA Gate
    ↓
Capability
    ↓
TNA Sentinel
    ↓
Approved OT / IT Control Adapter
    ↓
Operational System
    ↓
TNA Ledger
```

## Core deployment rule

Do not place experimental agent autonomy directly on safety-critical control loops.

Begin with:

- advisory actions;
- read-only monitoring;
- maintenance workflows;
- ticketing;
- non-critical configuration preparation.

## High-risk actions

Examples:

```text
read telemetry            → ALLOW
draft maintenance plan    → ALLOW
change production config  → HOLD
shutdown equipment        → multi-party approval
safety interlock change   → extremely restricted / separate process
```

## Sentinel: this is where the atomic-effect distinction matters most

Within a controllable session — a maintenance workflow, a diagnostic run — Sentinel can genuinely WARN, HOLD, or TERMINATE in response to command frequency, unexpected targets, unsafe sequence, timing deviations, network changes, or repeated actuator commands.

But an actuator command that has already executed — equipment that has already shut down, a physical setpoint that has already changed — is the most consequential version of an atomic, already-committed effect anywhere in this collection. Sentinel cannot reverse a physical action once it has occurred. Its role is limited to detection, containment, revocation of further authority, evidence creation, and preventing the next command.

This is precisely why the core deployment rule above keeps experimental autonomy off safety-critical control loops in the first place, and why shutdown/interlock actions sit at multi-party approval or a separate process rather than relying on Sentinel as a safety net. Sentinel is a containment and evidence layer here, not a substitute for a physical fail-safe or an interlock.

## Ledger

Evidence should be outside the controlled asset's immediate blast radius where practical.

## VAD: verify against operational telemetry, not the agent's own report

VAD provides a generic verification protocol; it does not provide a universal truth oracle. Independent verification should use trusted operational telemetry — a real sensor reading, a real system state — rather than the agent's own success message. Building that oracle is real per-system engineering work: a water-treatment agent's oracle and a data-center-cooling agent's oracle share no code.

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with real OT/IT control-adapter boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Should sit outside the controlled asset's own blast radius |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate — most OT actuation does not have one |
| Sentinel — atomic external effects | Limited after commit | Cannot reverse a physical action once executed — the highest-stakes case in this collection |
| VAD framework | High as a protocol | Oracle must be real operational telemetry, engineered per system |
| Novel anomaly detection | Not a current TNA claim | TNA is policy/deterministic-control driven, not a substitute for OT anomaly-detection tooling |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane. It is not a safety-certified industrial controller and does not replace deterministic safety systems, interlocks, physical fail-safes, or sector-specific regulation.

## Known limits

TNA cannot guarantee safe behavior if the TNA host/root of trust is compromised, trusted administrator credentials are stolen, a legitimate approver acts maliciously or is socially engineered, execution bypasses TNA entirely, trusted telemetry is compromised, harmful behavior stays within explicitly authorized scope, or governing policy does not yet cover the threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions. This caveat carries the most weight in this document of any in the collection.

## Example takeaway

> In critical infrastructure, TNA should govern autonomy around safety systems—not pretend to replace them.

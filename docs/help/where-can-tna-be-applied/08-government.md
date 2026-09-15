# TNA Deployment Example — Government

## Government Agentic Risk

Government agents may interact with:

- public records;
- benefits;
- permits;
- procurement;
- correspondence;
- investigations;
- internal systems;
- critical datasets;
- enforcement workflows.

The central problem is accountable authority.

## Architecture

```text
Government AI Agent
    ↓
TNA Gate
    ↓
Capability
    ↓
TNA Sentinel
    ↓
Government System / API / Workflow
    ↓
TNA Ledger
    ↓
VAD / Auditor / Control Center
```

## Recommended first pilot

Choose a low-to-medium-risk administrative workflow, such as:

- document routing;
- permit-status updates;
- benefits-case preparation;
- internal records processing.

Keep final legal or coercive decisions human-controlled.

## Gate

Policy should reflect real statutory and organizational authority.

An agent must not gain authority merely because it can technically reach a system.

## Separation of duties

For high-risk actions:

```text
agent proposes
→ authorized civil servant reviews
→ exact action approved
→ capability issued
→ execution observed
```

## Sentinel: monitoring a case, not undoing a disbursement

Within a case-processing session, Sentinel can watch for the same class of signals as elsewhere — unexpected record access, bulk operations, unusual destinations, repeated retries — and WARN, HOLD, or TERMINATE that session. This is the controllable-execution case.

Once a benefits payment has already disbursed, or a public record has already been updated in an external system, that effect is committed. Sentinel cannot reverse it; its role becomes detection, containment, revocation of the agent's further authority, evidence creation, and preventing the next action. This is the operational reason the separation-of-duties flow above puts human review *before* execution rather than after.

## Ledger

Government use strongly benefits from reconstructable evidence:

- who initiated;
- under which authority;
- which policy applied;
- who approved;
- what executed;
- what result occurred.

## VAD: administrative outcomes are verifiable; legal judgment is not a generic oracle

VAD provides a generic verification protocol, not a universal truth oracle. Independent verification can confirm administrative facts:

- record update;
- document delivery;
- status transition;
- execution outcome.

These can be checked against the system of record itself, not the agent's report. **Legal or policy reasoning is often not reducible to deterministic verification at all** — which is exactly why this page keeps final legal or coercive decisions human-controlled rather than something VAD is asked to certify.

## Regulator / oversight model

Operational authority, TNA enforcement, and external oversight should remain distinct.

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must reflect real statutory authority, not just system access |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage; supports regulator evidence requests |
| Approval separation | High | Human coercion/social engineering remains possible; this is the load-bearing control for accountable authority |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Cannot reverse a disbursement or record update once committed |
| VAD framework | High for administrative claims; not applicable to legal/policy judgment | Oracle must be the system of record, engineered per workflow |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane. It cannot make unlawful policy lawful, cannot replace due process, and cannot eliminate a malicious trusted insider — those remain human and legal accountability questions.

## Known limits

TNA cannot guarantee safe behavior if the TNA host/root of trust is compromised, trusted administrator credentials are stolen, a legitimate approver acts maliciously or is socially engineered, execution bypasses TNA entirely, trusted telemetry is compromised, harmful behavior stays within explicitly authorized scope, or governing policy does not yet cover the threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions.

## Example takeaway

> Government AI should be able to assist at scale without becoming an unaccountable source of state authority.

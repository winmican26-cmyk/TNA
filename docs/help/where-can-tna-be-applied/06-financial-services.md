# TNA Deployment Example — Financial Services

## Why Financial Services Is a Natural TNA Environment

AI agents in finance may:

- issue refunds;
- initiate transfers;
- update customer records;
- adjust limits;
- generate or submit trades;
- approve exceptions;
- communicate with customers;
- access sensitive financial data.

The risk is not merely incorrect text. It is unauthorized economic effect.

## Architecture

```text
Financial Agent
    ↓
TNA Gate
    ↓
Capability
    ↓
TNA Sentinel
    ↓
Banking / Payment / Trading / CRM Tool
    ↓
TNA Ledger
    ↓
VAD / Auditor / Control Center
```

## Recommended first pilot

Start with **refunds or payment adjustments**.

Example policy:

```text
read account                     → ALLOW
draft refund                     → ALLOW
refund ≤ threshold               → ALLOW or policy-controlled
refund > threshold               → HOLD
refund outside assigned account  → BLOCK
```

## Gate controls

Evaluate:

- agent identity;
- customer/account;
- amount;
- currency;
- transaction type;
- destination;
- risk class;
- daily budget;
- approval requirement.

## Sentinel controls: what happens after a refund has already settled

Watch for, while a transaction is still in flight:

- repeated transaction loops;
- unusual volume;
- abnormal amount aggregation;
- unexpected destinations;
- runtime cost;
- policy drift;
- expired capability.

This is Sentinel's controllable-execution case, and it can genuinely WARN, HOLD, or TERMINATE a session exhibiting these patterns before further transactions go out.

But a refund that has **already settled with the payment processor** is an atomic, already-committed effect — Sentinel cannot reverse it. Once the processor confirms, its role shifts to detection, containment, revocation of the agent's further transaction authority, evidence creation, and preventing the next transaction, not undoing the one that already cleared. This is exactly why the threshold policy above puts the control at Gate, before submission, for anything over the auto-allow threshold.

## Ledger evidence

Record:

- requested transaction;
- decision;
- approval;
- capability;
- execution response;
- resulting transaction identifier;
- verification.

## VAD: verify against the processor, not the agent

VAD provides a generic verification protocol; it does not provide a universal truth oracle. For a financial action, the oracle is the payment processor's own transaction record — not the agent's report that "the refund succeeded." Independently confirm:

- transaction actually settled or was rejected;
- correct amount;
- correct customer;
- correct destination;
- expected ledger state.

**The harder it is to define independent evidence of success, the less confidently an autonomous system should be permitted to claim success** — which is precisely why "the agent said the refund went through" is not, on its own, evidence in this environment.

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with real core-banking/payment IAM and action boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage |
| Tenant isolation | High within tested architecture | Multi-customer/multi-account isolation still needs enterprise integration |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Cannot reverse a transaction the processor has already settled |
| VAD framework | High as a protocol | Oracle must be the processor's own record, engineered per integration |
| Novel anomaly detection | Not a current TNA claim | TNA does not replace fraud-detection ML — see below |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane. It does not replace fraud detection, AML controls, banking regulation, transaction monitoring, or human financial governance — it governs autonomous execution through those systems.

## Known limits

TNA cannot guarantee safe behavior if the TNA host/root of trust is compromised, trusted administrator credentials are stolen, a legitimate approver acts maliciously or is socially engineered, execution bypasses TNA entirely, trusted telemetry is compromised, harmful behavior stays within explicitly authorized scope, or governing policy does not yet cover the threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions.

## Example takeaway

> An AI agent may recommend a financial action. TNA governs whether it becomes a real financial event.

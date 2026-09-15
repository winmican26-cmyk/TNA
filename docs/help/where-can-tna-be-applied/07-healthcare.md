# TNA Deployment Example — Healthcare

## Why Healthcare Needs Execution Governance

Healthcare agents may assist with:

- scheduling;
- documentation;
- patient messaging;
- medication workflows;
- orders;
- referrals;
- insurance workflows;
- clinical decision support;
- device or operational systems.

TNA should not decide clinical truth. It should govern what autonomous systems are permitted to do.

## Architecture

```text
Healthcare Agent
    ↓
TNA Gate
    ↓
Capability
    ↓
TNA Sentinel
    ↓
EHR / Scheduling / Messaging / Operational Tool
    ↓
TNA Ledger
    ↓
VAD / Auditor / Control Center
```

## Recommended first pilot

Begin with an administrative workflow, not autonomous diagnosis or treatment.

Example:

**appointment rescheduling or patient communication.**

## Gate controls

Possible dimensions:

- patient identity;
- agent role;
- permitted workflow;
- data sensitivity;
- destination;
- message type;
- whether human approval is required.

## High-risk separation

Examples:

```text
draft patient message      → ALLOW
send routine reminder      → policy-controlled
change medication order    → HOLD / human clinician required
alter diagnosis             → BLOCK unless explicitly governed
```

## Sentinel: what it can watch, and what it cannot undo

While a session is running, Sentinel can monitor:

- unexpected record access;
- cross-patient contamination;
- bulk operations;
- destination changes;
- repeated retries;
- unauthorized data export.

This is the controllable-execution case: a monitoring/messaging session is something Sentinel can WARN, HOLD, or TERMINATE mid-stream.

But once a message has already been sent to a patient, or a medication order has already transmitted to a pharmacy system, that is an atomic, already-committed effect. Sentinel cannot reverse it — its role becomes detection, containment, revocation of further authority, evidence creation, and preventing the next action, not un-sending the message. This is why the table above puts "change medication order" at HOLD *before* transmission rather than relying on Sentinel to catch it afterward.

## Ledger

Record who requested, approved, executed, observed, and verified the action.

## VAD: administrative facts are verifiable; clinical truth is not a generic oracle

VAD provides a generic verification protocol; it does not provide a universal truth oracle, and healthcare is the sharpest illustration of why that distinction matters. Use independent verification for administrative facts:

- appointment actually changed;
- correct patient;
- correct location/time;
- message sent to correct destination.

These can be checked against the scheduling or messaging system's own state — not the agent's report.

**Do not use VAD as a substitute for clinical judgment.** Whether a treatment decision is *correct* is not, in general, reducible to a deterministic verifier the way "did the appointment move" is. The harder it is to define independent evidence of success, the less confidently an autonomous system should be permitted to claim success — clinical correctness sits at the hard end of that spectrum, administrative state sits at the easy end, and this page only recommends piloting the latter.

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with real EHR/IAM and action boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage; subject to health-privacy law |
| Tenant isolation | High within tested architecture | Multi-patient / multi-department isolation still needs enterprise integration |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Cannot un-send a message or un-transmit an order once committed |
| VAD framework | High for administrative claims; not applicable to clinical judgment | Oracle must be engineered per claim type, and some claims (clinical correctness) have none |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane. It does not replace clinicians, clinical governance, medical-device regulation, patient-consent frameworks, health privacy law, hospital IAM, or medical safety processes.

## Known limits

TNA cannot guarantee safe behavior if the TNA host/root of trust is compromised, trusted administrator credentials are stolen, a legitimate approver acts maliciously or is socially engineered, execution bypasses TNA entirely, trusted telemetry is compromised, harmful behavior stays within explicitly authorized scope, or governing policy does not yet cover the threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions.

## Example takeaway

> TNA governs autonomous healthcare actions without pretending to replace clinical authority.

# TNA Deployment Example — Enterprise Automation

## Scope

Enterprise agents may act across:

- CRM;
- ERP;
- email;
- HR systems;
- ticketing;
- finance;
- procurement;
- document systems;
- customer support;
- internal workflows.

The challenge is that one agent may cross many systems with very different consequences.

## Architecture

```text
Enterprise Agent
    ↓
TNA Gate
    ↓
Capability
    ↓
TNA Sentinel
    ↓
MCP / API / Workflow Connector
    ↓
Enterprise System
    ↓
TNA Ledger
    ↓
VAD / Auditor / Control Center
```

## Best first pilot

Choose a workflow with clear read/write separation.

Example: customer-support agent.

```text
read customer record         → ALLOW
draft response               → ALLOW
send response                → policy-controlled
issue small credit           → policy-controlled
issue large refund           → HOLD
delete customer record       → special approval
```

## Gate

Apply policy per:

- tenant;
- identity;
- tool;
- operation;
- resource;
- customer;
- amount;
- destination;
- risk class.

## Sentinel: contains the connector, doesn't undo the send

Across a session touching multiple connected systems, Sentinel can watch for repeated actions, cross-tenant access, unexpected connectors, unusual outbound volume, cost overruns, retries, or capability expiry — and WARN, HOLD, or TERMINATE the session. This is its controllable-execution case.

But an email that has already sent, a refund already posted, or a CRM record already deleted is an atomic, already-committed effect in the target enterprise system — Sentinel cannot reverse it. Its role there is detection, containment, revoking the agent's further access to that connector, evidence creation, and preventing the next action. This is why "issue large refund" and "delete customer record" sit at HOLD/special approval *before* the connector call, rather than relying on Sentinel to catch it afterward.

## Ledger

Provide one causal chain across multiple enterprise systems.

## VAD: verify against the target system, not the agent's report

VAD provides a generic verification protocol; it does not provide a universal truth oracle — and in a multi-connector environment, the oracle differs per system. Verify claims such as:

- ticket closed — against the ticketing system;
- refund posted — against the payment/finance system;
- email sent — against the mail system or delivery receipt;
- CRM record changed — against the CRM's own state;
- order updated — against the order system.

Each of these is a different integration, not one generic check.

## MCP and connectors

Treat connector discovery separately from authorization.

> **Discovered ≠ Authorized**

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with each connected system's own IAM and action boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale, across many connectors |
| Ledger / provenance | High | Needs hardened, replicated, independent storage |
| Tenant isolation | High within tested architecture | Multi-tenant CRM/ERP federation still required |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Cannot reverse a send/post/delete once the target system commits it |
| VAD framework | High as a protocol | A distinct oracle must be engineered per connected system |
| Novel anomaly detection | Not a current TNA claim | "Unusual outbound volume" monitoring here is policy/threshold-driven, not adaptive ML |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane. It does not replace business-process design, data governance, IAM, DLP, or human accountability.

## Known limits

TNA cannot guarantee safe behavior if the TNA host/root of trust is compromised, trusted administrator credentials are stolen, a legitimate approver acts maliciously or is socially engineered, execution bypasses TNA entirely, trusted telemetry is compromised, harmful behavior stays within explicitly authorized scope, or governing policy does not yet cover the threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions.

## Example takeaway

> TNA gives enterprise agents controlled reach across many systems without turning connector access into unlimited authority.

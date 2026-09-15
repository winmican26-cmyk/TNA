# TNA Deployment Example — Other Agent Platforms

## A Vendor-Neutral Integration Pattern

TNA is designed around execution boundaries rather than one model vendor.

It can be applied anywhere an AI agent can cause real effects. This page is deliberately generic — it is the pattern the named-vendor pages in this collection each specialize.

## Generic architecture

```text
Model
    ↓
Agent Runtime
    ↓
TNA Gate
    ↓
Capability
    ↓
TNA Sentinel
    ↓
Execution Broker
    ↓
Tool / API / Shell / Browser / Database / Workflow
    ↓
TNA Ledger
    ↓
VAD / Auditor / Control Center
```

## Minimum integration requirements

A platform needs a place where TNA can intercept:

1. proposed action;
2. identity of the actor;
3. target tool/resource;
4. arguments or arguments hash;
5. execution result;
6. runtime observations.

## Good candidates

- agent SDKs;
- autonomous coding systems;
- RPA with LLM decision-making;
- enterprise copilots;
- workflow agents;
- browser agents;
- database agents;
- finance agents;
- internal operations agents;
- robotics control systems.

## Integration principle

TNA is easiest to apply when:

```text
intent != execution
```

There must be a controllable boundary between the model proposing an action and the system performing it.

> **A capability authorizes an action; it does not certify that the action is wise, correct, safe, or successful.** This holds regardless of platform — Gate's ALLOW/BLOCK/HOLD is an authorization decision, not a correctness or success claim.

## Sentinel depends on what the platform's execution substrate looks like

Because this page covers many kinds of platforms, Sentinel's real authority varies by integration, not by TNA itself:

- if the platform's execution is a **controllable substrate** — a workflow engine, a container, a long-running job — Sentinel can genuinely WARN, HOLD, TERMINATE, revoke future capabilities, or contain the session;
- if the platform's execution is a **single already-executed call** — one HTTP POST, one already-submitted database write — Sentinel cannot reverse it once committed. Its role there is detection, containment, revocation of future authority, evidence creation, and prevention of subsequent actions.

Whether a given platform integration gets the stronger or weaker form of Sentinel is a question to answer during integration design, not something TNA can promise uniformly across "agent platforms" as a category.

## VAD depends on what the platform can independently observe

VAD provides a generic verification protocol; it does not provide a universal truth oracle. For any platform integrated under this pattern, someone has to design the actual independent verifier — a database agent's oracle looks nothing like a robotics platform's oracle. Where the platform offers no independent way to observe the real effect of an action, VAD can only report INDETERMINATE, not fabricate confidence.

## Computer-use / browser agents: treat as an emerging surface

Browser agents are listed above as a good candidate for TNA governance, but computer-use mediation specifically is the least mature integration surface in this whole collection — the fuller treatment lives in the OpenAI application example's "Computer-Use Governance" section. **Pixels are not authority**: a click is not, by itself, evidence of the semantic action it was interpreted to authorize, and high-risk browser actions should default toward HOLD unless bound to a stronger signal than coordinates.

## Recommended pilot

Start with a single mutating tool and prove:

- unauthorized call is blocked;
- high-risk call is held;
- authorized call receives bounded capability;
- execution is observed;
- evidence is recorded;
- result is independently verified where appropriate.

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with the platform's own IAM and action boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage |
| Sentinel — controllable execution | High within tested execution substrates | Requires the platform to expose an interruptible runtime boundary |
| Sentinel — atomic external effects | Limited after commit | Can contain future behavior, not reverse a committed effect |
| VAD framework | High as a protocol | A real verifier/oracle must be engineered per platform |
| Computer-use semantic mediation | Emerging | Visual intent classification is adversarial and fallible |

## Known limits

Two kinds of limits apply here.

**Structural**: if a platform has no interceptable execution boundary and gives the model direct, unmediated control over privileged systems, it must first introduce one before TNA can govern it effectively.

**Root of trust**, as with every integration in this collection: TNA cannot guarantee safe behavior if the TNA host/root of trust is compromised, trusted administrator credentials are stolen, a legitimate approver acts maliciously or is socially engineered, execution bypasses TNA entirely, trusted telemetry is compromised, harmful behavior stays within explicitly authorized scope, or governing policy does not yet cover the threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions, and depends on the specific platform integration actually implementing the boundary this page assumes.

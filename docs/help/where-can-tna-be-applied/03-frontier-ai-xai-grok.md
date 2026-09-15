# TNA Deployment Example — xAI / Grok

## Applying Trust No Agent to Grok-Based Agentic Systems

> **Purpose.** This is an architectural example only. It does not claim that xAI currently uses TNA and does not describe private xAI infrastructure. It maps publicly understood classes of Grok-based agentic execution — tool calls, public communications, browser/computer actions — onto the TNA control model.

## Where TNA would sit

TNA would wrap consequential execution around Grok-based agents.

Potential surfaces include:

- tool execution;
- API calls;
- code execution;
- filesystem mutation;
- browser/computer actions;
- MCP-like tool connectivity;
- internal orchestration;
- production operations;
- self-modification.

```text
Grok / Grok Agent
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
Tools / APIs / Shell / Browser / Infrastructure
    ↓
TNA Ledger
    ↓
VAD / Auditor / Control Center
```

## Best first pilot

Choose actions that could create irreversible or externally visible effects:

- production changes;
- public communications;
- privileged API actions;
- code deployment;
- credential use;
- policy changes;
- infrastructure operations.

## Gate policy

Gate evaluates the requested action rather than trusting the model's reasoning.

Examples of policy dimensions:

```text
agent identity
tool
operation
resource
destination
arguments hash
risk class
environment
approval requirement
expiry
```

> **A capability authorizes an action; it does not certify that the action is wise, correct, safe, or successful.** Gate deciding a post *may* publish is not the same claim as VAD confirming it *did* publish correctly — see the VAD section below.

## Public-output and communication risk

If an agent can publish or send externally, treat "send", "post", "publish", or "commit" as state-changing operations.

A useful policy model:

```text
draft content        → allowed
preview content       → allowed
publish externally    → HOLD or policy-controlled ALLOW
```

This separates generation from irreversible action — and it is also the clearest illustration in this collection of why Sentinel cannot be relied on to catch a bad outcome after the fact (see below): once "publish" executes, the post is externally visible, and no amount of runtime monitoring un-publishes it.

## Sentinel role: what it can and cannot stop

**Controllable / long-running execution** — a multi-step agent session, a workflow, a container, an iterative tool sequence — gives Sentinel a real runtime boundary to act on. Here it may genuinely WARN, HOLD, TERMINATE, revoke future capabilities, or contain the session, in response to unexpected destinations, repeated action loops, excessive token/tool cost, command escalation, environment drift, or unauthorized process/network behavior.

**Atomic or already-committed external effects** — a post that has already published, a message that has already sent, a trade or order that has already executed — cannot be undone by Sentinel once committed. Sentinel can interrupt execution when the underlying execution substrate exposes a controllable runtime boundary; for atomic or already-committed external effects, it cannot reverse the committed effect — its role becomes detection, containment, revocation of future authority, evidence creation, and prevention of subsequent actions.

This is the direct reason the "publish externally → HOLD" policy above sits at Gate, before execution, rather than relying on Sentinel to catch a bad post afterward.

## Ledger role

Record not only the model request but the actual execution outcome.

For communications:

```text
draft generated
→ approval decision
→ send invoked
→ destination
→ execution result
→ verification
```

## VAD role: a protocol, not a truth oracle

VAD supplies a reusable workflow — producer, evidence, independent verifier, acceptance criteria, ACCEPT/REJECT/INDETERMINATE, provenance, bounded retries. **It does not supply a universal truth oracle**; each claim below needs its own independently designed check:

- **deployment completed** — expected commit hash, deployed revision, health endpoint;
- **content actually published** — independent confirmation that the content exists at the destination platform, not merely that the send API returned success;
- **data update succeeded** — the target system's own record, not the agent's report of it;
- **remediation worked / target system changed as intended** — re-observed state from the target system itself.

**The harder it is to define independent evidence of success, the less confidently an autonomous system should be permitted to claim success.**

## Computer-use / browser actions: treat as an emerging surface

Where a Grok-based agent acts through a browser rather than a typed API call, the same caution applies as elsewhere in this collection: **pixels are not authority.** A click or coordinate action is not, by itself, evidence of the semantic action it was interpreted to authorize — the fuller treatment lives in the OpenAI application example's "Computer-Use Governance" section. High-risk, hard-to-reverse browser actions should default toward HOLD unless authorization binds to something stronger than coordinates.

## Recursive improvement

A Grok-based autonomous system must not gain authority simply because it improves.

Classify separately:

- competence changes;
- tool additions;
- capability expansion;
- evaluator changes;
- policy changes;
- control-plane changes.

> **COMPETENCE CHANGE ≠ AUTHORITY CHANGE ≠ CONTROL-PLANE CHANGE**

The higher classes should require independent approval — this governs successor promotion and authority expansion under defined controls, not a claim that autonomous self-improvement has been proven safe.

## Recommended pilot

A strong first demonstration:

**agent drafts a public or operational action, but TNA requires authorization before the action becomes externally effective.**

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with real IAM and real action boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Can contain future behavior, not reverse a committed (e.g. published) effect |
| VAD framework | High | Verifiers/oracles must be engineered per domain |
| Computer-use semantic mediation | Emerging | Visual intent classification is adversarial and fallible |
| Novel anomaly detection | Not a current TNA claim | TNA is primarily policy/deterministic-control driven |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane — it complements, not replaces, trust-and-safety review, platform moderation, IAM, observability, and human sign-off on public communications.

## Known limits

TNA cannot guarantee safe behavior if:

- the TNA host or root of trust is compromised;
- trusted administrator credentials are stolen;
- privileged operators act maliciously;
- an approver is socially engineered;
- an entire tool path bypasses TNA;
- trusted telemetry is compromised;
- the action is harmful while still technically within its granted scope;
- the governing policy does not yet cover the harmful behavior.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions.

## Example takeaway

> Generation is not execution. TNA makes that separation enforceable.

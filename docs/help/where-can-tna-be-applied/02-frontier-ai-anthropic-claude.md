# TNA Deployment Example — Anthropic / Claude

## Applying Trust No Agent to Claude-Based Agentic Systems

> **Purpose.** This is an architectural example, not a claim that Anthropic currently uses TNA and not a description of private Anthropic infrastructure. It maps publicly understood classes of Claude-based agentic execution — coding-agent tool use, MCP, computer use, deployment — onto the TNA control model.

## Where TNA would sit

TNA would govern the execution layer surrounding Claude-based agents rather than the model itself.

Potential surfaces include:

- Claude Code or similar coding-agent execution;
- tool invocation;
- MCP tool dispatch;
- shell and filesystem mutation;
- computer-use workflows;
- internal agent orchestration;
- deployment and infrastructure changes;
- self-modification or successor promotion.

Conceptually:

```text
Claude / Claude-based Agent
    ↓
Agent Harness
    ↓
TNA Gate
    ↓
Bounded Capability
    ↓
TNA Sentinel
    ↓
Execution Broker
    ↓
Shell / Files / MCP / API / Computer Use
    ↓
TNA Ledger
    ↓
VAD / Auditor / Control Center
```

## Highest-risk pilot wedge

Begin with one class of actions:

**agents that can modify their own code, permissions, deployed configuration, supervising infrastructure, or production systems.**

Do not start by governing every read-only interaction.

## Gate role

Before an action executes, Gate should decide whether the exact action is inside the agent's authority.

Examples:

- write this file;
- execute this command;
- call this MCP tool;
- send this request;
- deploy this commit;
- modify this policy;
- access this secret.

The output is:

```text
ALLOW
BLOCK
HOLD
```

For high-risk actions, HOLD should require a distinct human approver.

> **A capability authorizes an action; it does not certify that the action is wise, correct, safe, or successful.** That judgment, where it can be made at all, belongs to VAD, not to Gate — see below.

## Sentinel role: controllable sessions vs. already-committed effects

Sentinel's ability to act on a Claude-based agent's in-progress work depends on what the action actually is.

**Controllable / long-running execution** — a shell session, a multi-step agent run, an iterative tool sequence, a container the agent is operating in — is something Sentinel can genuinely watch and intervene on: WARN, HOLD, TERMINATE, revoke future capabilities, or contain the session, in response to signals like unexpected process spawning, undeclared path access, prohibited network destinations, excessive runtime, cost overrun, capability expiry, privilege escalation, or unexpected tool substitution.

**Atomic or already-committed external effects** — a shell command that has already run and mutated files, a deployment that has already gone live, a production API call that already executed — are different. Sentinel can interrupt execution when the underlying execution substrate exposes a controllable runtime boundary; for atomic or already-committed external effects, it cannot reverse the committed effect. Its role there is detection, containment, revocation of future authority, evidence creation, and prevention of subsequent actions — not undoing what already happened.

This is exactly why the recommended pilot below holds *before* production deployment rather than relying on catching a bad deploy afterward.

## Ledger role

The Ledger should record authoritative evidence of:

- action proposal;
- Gate decision;
- approval;
- capability issuance;
- execution start;
- runtime observations;
- result;
- verification outcome.

The agent's own statement is not evidence of success.

## VAD role: a protocol, not a truth oracle

Use VAD when Claude claims something consequential is complete:

- code patch works;
- deployment succeeded;
- migration completed;
- security change is effective;
- configuration was updated.

VAD supplies the reusable workflow — producer, evidence, independent verifier, acceptance criteria, ACCEPT/REJECT/INDETERMINATE, provenance, bounded retries. **It does not supply a universal truth oracle.** For a coding/deployment agent this is a strong fit: the verifier checks an expected commit hash, the deployed revision, a health endpoint, an artifact signature — things Claude did not compute itself. Independent systems, not the agent, should confirm the claim.

## Computer-use workflows: treat as an emerging surface

Where Claude-based agents operate through computer use rather than typed tool calls, the same caution applies as anywhere else in this collection: **pixels are not authority.** A click is inferred to mean something ("confirm this change," "approve this transaction") and that inference can be wrong, stale, or manipulated. This is a genuinely less mature integration point than Gate or Ledger — the fuller treatment lives in the OpenAI application example's "Computer-Use Governance" section and applies identically here. High-risk, hard-to-reverse GUI actions should default toward HOLD unless authorization can bind to something stronger than coordinates (DOM/accessibility-tree identity, target resource, application state).

## Recursive improvement

A Claude-based self-improving workflow should follow:

> **COMPETENCE CHANGE ≠ AUTHORITY CHANGE ≠ CONTROL-PLANE CHANGE**

The agent may propose a better implementation.

It may not silently grant itself more tools, wider filesystem scope, broader network access, weaker evaluators, or authority to approve its own successor. This model governs successor promotion and authority expansion under defined controls — it is not a claim that self-improving agents have been proven safe in general.

## Recommended pilot

Use a coding/deployment agent with a deliberately constrained production-like workflow:

1. agent proposes code change;
2. Gate allows code generation but holds production deployment;
3. human approves exact deployment;
4. Sentinel observes execution;
5. Ledger records the causal chain;
6. VAD independently verifies deployed version and health.

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with real IAM and real action boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Can contain future behavior, not reverse a committed effect |
| VAD framework | High | Verifiers/oracles must be engineered per domain |
| Recursive Improvement Governance | Strong control architecture | Frontier-scale deployment evidence still needed |
| Computer-use semantic mediation | Emerging | Visual intent classification is adversarial and fallible |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane — it complements, not replaces, model safety systems, IAM, sandboxing, host security, SIEM, observability, secret managers, human security review, incident response, and supply-chain security.

## Known limits

TNA does not remove risks from:

- compromise of the TNA host or root of trust;
- stolen trusted operator credentials;
- legitimate approvers acting maliciously;
- social engineering of legitimate approvers;
- execution that bypasses TNA entirely (including supply-chain paths outside the governed route);
- compromised or untrusted telemetry;
- malicious behavior that remains entirely within authorized scope;
- policy that does not yet cover a given threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions.

## Example takeaway

> Claude may decide what it wants to do. TNA decides whether that action is authorized to happen.

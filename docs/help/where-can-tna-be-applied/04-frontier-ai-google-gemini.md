# TNA Deployment Example — Google / Gemini

## Applying Trust No Agent to Gemini-Based Agentic Systems

> **Purpose.** This is an architectural example, not a claim that Google currently uses TNA and not a description of private Google infrastructure. It maps publicly understood classes of Gemini-based agentic execution — function calling / tool use, Vertex AI-style agent orchestration, Google Workspace integrations, cloud infrastructure operations — onto the TNA control model, using only generic, publicly understood Gemini/agent/cloud execution patterns.

## Where TNA would sit

TNA would govern the execution layer surrounding Gemini-based agents rather than the model itself — the same boundary as elsewhere in this collection: the point where a proposed action would actually touch a real system.

Potential surfaces include:

- function calling / tool use;
- agent-orchestration layers of the kind publicly described for Vertex AI-style agent building (tool routing, multi-step planning, connector invocation);
- Google Workspace integrations (documents, mail, calendars, spreadsheets);
- cloud infrastructure mutation (compute, storage, IAM, networking);
- browser/computer-use actions, where an agent operates on a web page or application UI rather than a typed API;
- internal orchestration and pipeline automation;
- self-modification or successor promotion for an internally deployed agent.

Conceptually:

```text
Gemini / Gemini-based Agent
    ↓
Agent Runtime / Orchestrator
    ↓
TNA Gate
    ↓
Bounded Capability
    ↓
TNA Sentinel
    ↓
Execution Broker
    ↓
Function Call / Connector / Workspace API / Cloud API / Computer Use
    ↓
TNA Ledger
    ↓
VAD / Auditor / Control Center
```

## Existing IAM remains authoritative

TNA would not replace Google Cloud IAM, Workspace admin controls, or an organization's own identity and access system. Those remain authoritative for who and what can technically reach a resource. TNA adds a separate question on top: *even if this identity technically has access, should this autonomous action be allowed right now?* An agent's service account may legitimately have Cloud IAM permission to modify infrastructure; that does not mean every proposed change should execute unreviewed.

## Gate role and bounded capabilities

Before an action executes, Gate should decide whether the exact action is inside the agent's authority — a specific function call, a specific Workspace document edit, a specific cloud resource mutation — not just whether the underlying credential technically permits it. If allowed, Gate issues a short-lived, single-use bounded capability scoped to that exact action, so a permitted call cannot be silently substituted for a different one afterward.

```text
ALLOW
BLOCK
HOLD
```

> **A capability authorizes an action; it does not certify that the action is wise, correct, safe, or successful.** Whether it actually worked is VAD's question, not Gate's — see below.

## Sentinel: controllable sessions vs. already-committed effects

**Controllable / long-running execution** — a multi-step agent session, an orchestrated pipeline, a container, an iterative tool-calling loop — is something Sentinel can genuinely watch and act on: WARN, HOLD, TERMINATE, revoke future capabilities, or contain the session, in response to unexpected tool substitution, undeclared resource access, excessive runtime or cost, capability expiry, or scope expansion.

**Atomic or already-committed external effects** — a Workspace document that has already been edited, a cloud resource that has already changed state, a function call that has already returned success — are different. Sentinel cannot reverse a committed effect once it happens; its role becomes detection, containment, revocation of further authority, evidence creation, and preventing the next action. This is why a proposed infrastructure or Workspace mutation with real consequences belongs at Gate, as a HOLD or a scoped ALLOW, rather than something Sentinel is relied on to undo afterward.

## Ledger role

The Ledger should record authoritative evidence of the proposal, the Gate decision, any approval, the capability issued, execution start, runtime observations, the result, and the verification outcome — produced by the component that actually performed or observed the event, not the agent's own report.

## VAD: a protocol, not a truth oracle

VAD supplies a reusable workflow — producer, evidence, independent verifier, acceptance criteria, ACCEPT/REJECT/INDETERMINATE, provenance, bounded retries. **It does not supply a universal truth oracle.** Each claim needs its own independently designed check:

- a cloud deployment's oracle checks the actual deployed resource state, not the agent's report;
- a Workspace edit's oracle checks the document's real content/revision, not the agent's claim that it wrote the right thing;
- open-ended judgment calls (e.g. "is this the right document to have edited") are often not reducible to a deterministic verifier at all.

**The harder it is to define independent evidence of success, the less confidently an autonomous system should be permitted to claim success.**

## Tool / connector governance

Function calling and connector-based tool use are natural integration points for TNA, in the same shape as MCP elsewhere in this collection (an open, cross-vendor protocol also usable here, not proprietary to any one platform): discovery, policy mapping, Gate, capability, invocation, Ledger.

> **Discovered ≠ Authorized.** An agent may know a tool or connector exists without being permitted to invoke it.

## Computer-use: treat as an emerging surface

Where a Gemini-based agent acts on a web page or application UI — the kind of capability publicly discussed in browser-agent research such as Google DeepMind's Project Mariner prototype, described here only as a general category, not as a claim about its internal architecture — the same caution applies as elsewhere in this collection: **pixels are not authority.**

*Candidate principle — not yet formally registered in the TNA control catalog (which uses a `TNA-<CATEGORY>-<NNN>` scheme, e.g. `TNA-CAP-003`), and not to be added to it as part of this document: "Visual Intent Is Not Execution Authority — authorization of a computer-use action must be bound to the intended semantic effect and relevant application state, not merely to coordinates or pixels." Informal short form: "a click is not a capability."*

High-risk, hard-to-reverse browser/UI actions should default toward HOLD unless authorization can bind to something stronger than coordinates (DOM/accessibility-tree identity, the target resource, application state).

## Recursive improvement governance

An internally deployed Gemini-based agent that can modify its own prompt, tool access, evaluator, or approval policy must be governed the same way as elsewhere in this collection:

> **COMPETENCE CHANGE ≠ AUTHORITY CHANGE ≠ CONTROL-PLANE CHANGE**

A better prompt or a faster pipeline is a competence change. Adding a tool, widening resource access, or approving its own successor is an authority or control-plane change, and must not happen as a silent side effect of the first. This governs successor promotion and authority expansion under defined controls — it is not a claim that self-improving agents have been proven safe in general.

## Recommended pilot

Start narrow: govern one workload where a Gemini-based agent can mutate cloud infrastructure or Workspace content, using a deliberately constrained flow —

1. agent proposes a specific change (a function call with concrete arguments);
2. Gate evaluates identity, authority envelope, target resource, and risk class;
3. low-risk/reversible changes may ALLOW; high-risk/hard-to-reverse changes HOLD for a distinct human approver;
4. Sentinel observes the session;
5. Ledger records the causal chain;
6. VAD independently checks the real resulting state.

## Example: governed Workspace/cloud action

```text
1. Agent proposes: update_spreadsheet(sheet_id=..., range=..., values=...)
2. Gate evaluates agent identity, authority envelope, target sheet ownership, risk class.
3. Result = ALLOW (bounded capability: this sheet, this range, single use, short expiry)
   — or HOLD, if policy classifies this sheet/range as high-risk.
4. Execution broker invokes the Workspace API with the bounded capability.
5. Sentinel observes the call for scope/cost/destination anomalies.
6. Ledger records proposal, decision, capability, execution, result.
7. VAD independently reads the sheet back and checks the actual resulting values
   against the expected write — not the agent's report that it "updated the sheet."
8. Final status: VERIFIED / REJECTED / INDETERMINATE.
```

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with real Cloud IAM / Workspace admin boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Cannot reverse a Workspace edit or cloud mutation once committed |
| VAD framework | High as a protocol | Oracle must read back real resource/document state, engineered per integration |
| Recursive Improvement Governance | Strong control architecture | Frontier-scale deployment evidence still needed |
| Computer-use semantic mediation | Emerging | Visual intent classification is adversarial and fallible |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane — it complements, not replaces, Cloud IAM, Workspace admin controls, model safety systems, sandboxing, SIEM, observability, secret managers, human security review, incident response, and supply-chain security.

## Known limits

TNA cannot guarantee safe behavior if the TNA host/root of trust is compromised, trusted administrator credentials are stolen, a legitimate approver acts maliciously or is socially engineered, execution bypasses TNA entirely, trusted telemetry is compromised, harmful behavior stays within explicitly authorized scope, or governing policy does not yet cover the threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions.

## Example takeaway

> A Gemini-based agent may decide a change is worth making. TNA decides whether that change is authorized to happen, and independently checks whether it actually did.

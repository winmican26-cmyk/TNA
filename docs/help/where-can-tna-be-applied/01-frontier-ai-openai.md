# TNA Deployment Example — OpenAI

## Applying Trust No Agent to a Frontier AI Organization

> **Purpose**
>
> This document is an architectural example showing how Trust No Agent (TNA) could be applied to an organization operating advanced AI agents, using OpenAI as the example environment.
>
> It is not a claim that OpenAI currently uses TNA, and it does not describe private OpenAI infrastructure. It maps publicly understood classes of agentic execution—tool calls, shell/file operations, MCP, computer use, deployments, internal orchestration, and self-modifying workflows—onto the TNA control model.
>
> The goal is to show **where TNA sits, what it governs, what it does not replace, and how an enterprise rollout could be phased safely**.

---

# 1. The Core Idea

TNA does not sit inside the model.

It does not change what a model thinks, predicts, or generates.

It sits around the **execution boundary**—the point where an AI agent attempts to do something that can affect the real world.

Examples include:

- writing or deleting files;
- invoking tools;
- calling APIs;
- issuing refunds;
- sending messages;
- changing infrastructure;
- deploying code;
- altering IAM or credentials;
- modifying its own configuration;
- creating or changing tools;
- promoting a successor version of itself;
- changing security or control-plane components.

The fundamental separation is:

```text
MODEL / AGENT
    ↓
AGENT HARNESS
    ↓
TNA GATE
    ↓
CAPABILITY ISSUANCE
    ↓
TNA SENTINEL
    ↓
EXECUTION BROKER
    ↓
TOOL / MCP / SHELL / COMPUTER / API
    ↓
TNA LEDGER
    ↓
VAD / AUDITOR / CONTROL CENTER
```

The model may **propose** an action.

The model does not automatically get to decide whether that action is authorized to execute.

---

# 2. Where TNA Would Integrate

In an OpenAI-like environment, TNA would be placed around the agentic execution layer rather than inside the model itself.

Potential integration surfaces include:

- agent tool dispatch;
- shell execution;
- filesystem mutation;
- MCP tool invocation;
- computer-use actions;
- API execution;
- deployment workflows;
- cloud infrastructure mutation;
- credential and secret access;
- internal agent orchestration;
- self-improvement pipelines;
- model or policy promotion systems.

The purpose is not to replace the existing agent runtime.

The purpose is to introduce a **governed decision boundary before and during execution**.

---

# 3. Start with the Highest-Risk Actions

A large AI company should not attempt to route every low-risk action through the strictest possible workflow on day one.

The first rollout should focus on actions where an ungoverned failure would have serious consequences.

Examples:

- production deployments;
- infrastructure mutations;
- shell commands with persistent effects;
- file writes outside ephemeral sandboxes;
- database mutations;
- IAM changes;
- secret retrieval;
- external financial actions;
- outbound communications;
- changes to agent permissions;
- changes to agent code or configuration;
- modifications to safety or security systems;
- creation of new tools;
- recursive self-improvement;
- successor promotion.

A practical first rule could be:

```text
if action is low-risk and read-only:
    use existing execution path

if action can create meaningful external state:
    use TNA-governed execution path
```

---

# 4. TNA Gate in the Tool-Execution Path

A conventional agent loop may look like:

```text
model
→ tool call
→ tool executor
→ result
→ model
```

With TNA:

```text
model
→ proposed tool call
→ TNA Gate
→ ALLOW / BLOCK / HOLD
→ capability
→ execution broker
→ tool
→ result
→ agent
```

The agent does not receive blanket authority merely because it can see or call a tool.

TNA evaluates the proposed action in context.

Possible decision inputs include:

```text
principal
tenant
agent identity
tool
operation
resource
arguments hash
destination
risk class
requested effect
environment
current authority
approval requirement
budget
```

If the action is allowed, Gate can issue a short-lived, single-use capability bound to that exact action.

That helps prevent a permitted action from being silently transformed into a different one after authorization.

> **A capability authorizes an action; it does not certify that the action is wise, correct, safe, or successful.** Gate answers "is this allowed to happen." Whether it actually worked is a separate question — see section 9.

---

# 5. Existing IAM Remains Authoritative

TNA should not replace the organization's existing identity and access-management system.

The existing organization remains authoritative for:

- employee identities;
- service identities;
- tenant identities;
- project membership;
- API ownership;
- cloud roles;
- credential issuance;
- organizational permissions.

TNA adds another question:

> **Even if this identity technically possesses access, should this autonomous action be allowed right now?**

For example, an internal coding agent may legitimately possess deployment credentials. That does not mean every production deployment should automatically execute.

TNA can evaluate:

```text
agent identity
+ deployment target
+ environment
+ code ownership
+ risk class
+ incident state
+ requested effect
+ approval requirement
```

and return:

```text
ALLOW
BLOCK
HOLD
```

---

# 6. Human Approval for High-Risk Actions

Not every action should require a human.

A scalable deployment requires risk classes.

| Risk Class | Example | Possible TNA Behavior |
|---|---|---|
| R0 | Read public documentation | Auto-allow |
| R1 | Edit sandbox file | Auto-allow with evidence |
| R2 | Modify non-production internal resource | Allow with bounded controls |
| R3 | Production mutation | HOLD or policy-specific approval |
| R4 | IAM, credential, or security control change | Mandatory distinct approver |
| R5 | Authority, evaluator, control-plane, or self-promotion change | Multi-party approval; never self-approved |

Approvers should map to real accountable organizational roles, such as service owner, security lead, safety lead, SRE, incident commander, change manager, or governance reviewer.

The agent must not become its own approver.

---

# 7. TNA Sentinel During Execution

Gate answers:

> **Is this action authorized to begin?**

Sentinel answers:

> **Is execution still operating within the permitted boundaries?**

An action can begin legitimately and still become dangerous. Sentinel's authority to do anything about that, however, depends on what kind of action it is.

**Controllable / long-running execution** — a shell session, a container, a workflow, a long-running job, a multi-step agent session, an iterative tool sequence — exposes a runtime boundary Sentinel can act on directly. Here Sentinel may genuinely produce:

```text
CONTINUE
WARN
HOLD
TERMINATE
INDETERMINATE
```

in response to signals such as unexpected process creation, access to undeclared files, connection to prohibited destinations, excessive runtime or cost, capability expiry, tool substitution, scope expansion, network-policy violations, or attempted privilege escalation.

**Atomic or already-committed external effects** — a single API call that has already returned success, a deployment that has already gone live, an outbound message that has already sent — are different. Once the external system has committed the effect, Sentinel cannot undo time.

> Sentinel can interrupt execution when the underlying execution substrate exposes a controllable runtime boundary. For atomic or already-committed external effects, Sentinel cannot reverse the committed effect; its role becomes detection, containment, revocation of future authority, evidence creation, and prevention of subsequent actions.

For atomic, hard-to-reverse actions, the strongest preventive control is generally pre-execution authorization at Gate; Sentinel then contributes observation, containment, evidence, and prevention of subsequent actions.

Existing telemetry and observability should feed Sentinel where possible. TNA should consume trusted signals rather than unnecessarily replacing the company's monitoring stack. Sentinel's containment logic is policy- and signal-driven, not adaptive anomaly detection — see the maturity notes below.

---

# 8. TNA Ledger as the Evidence Plane

The authoritative evidence system should not live inside the same mutable blast radius as the agents it records.

A stronger deployment model would look like:

```text
Agent Execution Cluster
        │
        │ authenticated evidence event
        ▼
Evidence Ingest Boundary
        │
        ▼
TNA Ledger
        │
        ├── append-oriented event storage
        ├── hash-chain verification
        ├── tenant / stream isolation
        ├── restricted administrative access
        └── evidence reconstruction
```

The execution system should be able to produce evidence. It should not be able to silently rewrite its history through the normal application path.

> **Authoritative evidence must be produced by the component that actually performed or observed the event.**

Agent self-report is not authoritative evidence.

---

# 9. Verified Atomic Development for Consequential Claims

VAD is useful when an agent makes consequential claims such as "the deployment succeeded," "the migration completed," "the security patch works," "the data was deleted," or "the evaluation passed."

Instead of accepting the agent's statement—"Done."—TNA can require independent verification.

```text
Producer Agent
    ↓
Performs deployment
    ↓
Independent Verifier
    ↓
Checks external deployment state
Checks expected version hash
Checks health conditions
Checks required evidence
    ↓
VAD
    ↓
ACCEPT / REJECT / INDETERMINATE
```

The producer should not be able to define its own success oracle.

It is worth being precise about what VAD itself is. **VAD provides a generic verification protocol. It does not provide a universal truth oracle.** The protocol — producer, evidence, independent verifier, acceptance criteria, ACCEPT/REJECT/INDETERMINATE, provenance, bounded retries, lifecycle — is reusable. The verifier logic behind it is not; it has to be engineered per domain, because "success" means something different every time:

- a software deployment's oracle checks an expected commit hash, deployed revision, health endpoint, and artifact signature — this is the strongest fit for a coding/deployment agent, and the example in section 13 uses exactly this shape;
- a financial action's oracle checks the payment processor's own transaction record, not the agent's report of it;
- other domains — especially ones involving legal, policy, or open-ended judgment calls — are often not reducible to a deterministic verifier at all.

> **The harder it is to define independent evidence of success, the less confidently an autonomous system should be permitted to claim success.**

---

# 10. MCP Integration

MCP is a natural integration point for TNA.

Without TNA:

```text
Agent → MCP Server
```

With TNA:

```text
Agent
→ TNA MCP Gateway
→ tool discovery
→ policy mapping
→ Gate
→ capability
→ MCP invocation
→ result
→ Ledger
```

A key TNA principle applies:

> **Discovered ≠ Authorized**

An agent may know a tool exists without being permitted to invoke it.

---

# 11. Computer-Use Governance — Emerging / High-Risk Integration Area

Computer-use mediation is not equal in maturity to Gate or Ledger. It is the least mature integration surface described in this document, and should be labeled that way in any real planning rather than presented as a solved problem.

Computer-use agents require more than simple API authorization because actions arrive as GUI interactions rather than typed function calls:

```text
click "View invoice"      → low risk
click "Issue refund"      → high risk
type into email body      → medium risk
click "Send"              → state-changing
change IAM role           → critical
```

A raw `click(x, y)` has weak security semantics on its own. To govern the example above, TNA has to *infer* that a given click means "confirm wire transfer" — and that inference can be incorrect, stale, adversarially manipulated, disrupted by overlays or moving elements, subject to race conditions, thrown off by a mismatch between the DOM and the screenshot the model saw, misled by deceptive labels, or invalidated by application state changing between observation and action.

> **PIXELS ARE NOT AUTHORITY.**

*Candidate principle — not yet formally registered in the TNA control catalog (which uses a `TNA-<CATEGORY>-<NNN>` scheme, e.g. `TNA-CAP-003`), and not to be added to it as part of this document: "Visual Intent Is Not Execution Authority — authorization of a computer-use action must be bound to the intended semantic effect and relevant application state, not merely to coordinates or pixels." Informal short form: "a click is not a capability."*

A TNA computer-use adapter would still attempt to classify the semantic action before the environment executes it:

```text
model proposes GUI action
→ action classified
→ Gate decision
→ capability
→ UI action executes
→ Sentinel observes
→ Ledger records
```

But where possible, high-risk computer-use actions should bind authorization to stronger signals than pixel coordinates — DOM element identity, accessibility-tree identity, an application resource identifier, the semantic action itself, the target account/customer/resource, the destination, application state, a state/screen hash, or an expected precondition. **Where reliable semantic binding is unavailable, high-risk irreversible GUI actions should default toward HOLD**, not ALLOW.

---

# 12. Recursive Improvement Governance

This becomes especially important for frontier AI organizations.

An advanced internal agent may attempt to change its own prompt, modify its scheduler, replace its evaluator, add a tool, increase network access, change approval policy, modify security controls, or deploy a successor.

TNA treats these changes differently, classifying separately across: competence changes, code/algorithm changes, tool changes, capability expansion, model/provider changes, evaluator changes, policy changes, authority changes, and control-plane changes.

> **COMPETENCE CHANGE ≠ AUTHORITY CHANGE ≠ CONTROL-PLANE CHANGE**

An agent may improve its competence without automatically receiving additional authority.

Changes involving authority, evaluators, approval policy, security enforcement, control-plane logic, privileged tools, or successor promotion must not silently auto-promote.

The agent may propose such a change. It does not become the authority that approves it. Put precisely: this model **governs successor promotion and authority expansion under defined controls** — it is not a claim that recursive self-improvement has been proven safe in general.

---

# 13. Example: Governed Production Deployment

Consider an internal coding agent that wants to deploy code.

```text
1. Agent determines that deployment is required.

2. Agent proposes:

   deploy(
      repo=company/service-x,
      commit=abc123,
      environment=production
   )

3. TNA Gate receives the proposed action.

4. Gate evaluates:
   - agent identity;
   - authority envelope;
   - target environment;
   - change class;
   - approval requirement;
   - budget;
   - deployment restrictions.

5. Result = HOLD.

6. Appropriate human reviewer receives the exact current action.

7. Human approves the action.

8. Gate issues a short-lived capability bound to:
   - commit abc123;
   - service-x;
   - production;
   - deployment tool;
   - expiry.

9. Execution broker invokes the deployment system.

10. Sentinel observes execution.

11. Ledger records:
    - proposal;
    - decision;
    - approval;
    - capability;
    - execution;
    - runtime observations;
    - result.

12. VAD independently checks the real deployment environment.

13. VAD verifies:
    - deployed version;
    - expected hash;
    - health condition;
    - required evidence.

14. Final status becomes:
    VERIFIED / REJECTED / INDETERMINATE.

15. Control Center presents the causal chain.
```

The key separation is:

> **"The agent believes deployment is necessary" does not automatically become "production was changed."**

Note where Sentinel's atomic-effect limit (section 7) actually bites here: once step 9 executes, a bad deployment is already live. Sentinel did not prevent that — Gate's HOLD at step 5 did. Sentinel's contribution from step 10 onward is observing, containing, and feeding VAD's independent check; if VAD rejects, the response is remediation and revocation of further capability, not un-deploying by decree.

---

# 14. Recommended Enterprise Pilot

A frontier AI organization should not begin with a company-wide mandate.

A controlled pilot might govern three workloads:

## Workload A — Coding / Deployment Agent

Govern shell execution, file mutation, infrastructure changes, deployment, and credential access.

## Workload B — MCP-Connected Enterprise Agent

Govern discovered tools, mutating tool calls, external APIs, financial or communication actions, and credential lifecycle.

## Workload C — Self-Improvement Agent

Govern candidate creation, evaluator changes, capability changes, authority changes, promotion, and rollback.

Measure:

```text
actions attempted
actions allowed
actions blocked
actions held
false blocks
approval latency
runtime overhead
Sentinel interventions
verification failures
evidence coverage
operator burden
bypass attempts
```

Expansion should be evidence-driven.

---

# 15. Where the TNA Control Plane Should Live

At enterprise scale, TNA should be isolated as a security control plane.

```text
AI AGENT SYSTEMS
      │
      │ authenticated requests
      ▼
────────────────────────────────
TNA SECURITY CONTROL PLANE
────────────────────────────────
Gate
Capability Service
Sentinel Decision Service
Evidence Ingest
Ledger
VAD Verification
Auditor
Policy Administration
Control Center
────────────────────────────────
      │
      ▼
Execution Infrastructure
```

The ordinary agent runtime should not possess administrative authority over the TNA control plane itself.

---

# 16. Government or Regulatory Oversight

A mandated deployment does not imply that regulators should approve every action.

Three layers should remain distinct:

```text
Company operational control
TNA technical enforcement
Government / regulator assurance
```

A regulator may receive assurance reports, agreed evidence packages, control-coverage metrics, incident evidence, verification results, documented limitations, and proof that prohibited authority paths are technically unavailable under the governed design.

Runtime operational control should generally remain with the organization unless law or policy explicitly requires otherwise.

---

# 17. What TNA Does Not Replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane. It should complement, not replace:

- model safety systems;
- IAM;
- sandboxing;
- host security;
- SIEM;
- observability;
- endpoint security;
- deployment systems;
- secret managers;
- human security review;
- incident response;
- supply-chain security.

---

# 18. Enterprise-Scale Engineering Required

A production deployment at frontier-AI scale would require substantial engineering beyond a pilot implementation.

Likely requirements include distributed Gate services, highly available capability issuance, enterprise identity federation, large-scale policy distribution, replicated evidence storage, high-throughput event ingestion, regional deployments, disaster recovery, managed signing keys, KMS/HSM integration, hardened root-of-trust infrastructure, fleet-wide Sentinel telemetry, stronger host-level enforcement, performance budgets, failover, bypass governance, and regulator-ready evidence exports.

These are scale and assurance requirements. They do not change the fundamental TNA control model.

---

# 19. Maturity and Integration Caveats

This document touches nearly every TNA capability, so its caveat table is the fullest in the collection — narrower application examples elsewhere include only the rows relevant to that environment.

| TNA Capability | Current Confidence | Enterprise / Frontier-Lab Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with real IAM and real action boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage |
| Tenant isolation | High within tested architecture | Enterprise federation still required |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Can contain future behavior, not reverse a committed effect |
| VAD framework | High | Verifiers/oracles must be engineered per domain |
| Recursive Improvement Governance | Strong control architecture | Frontier-scale deployment evidence still needed |
| Computer-use semantic mediation | Emerging | Visual intent classification is adversarial and fallible |
| Novel anomaly detection | Not a current TNA claim | TNA is primarily policy/deterministic-control driven |

The distinctions matter: implementation maturity, integration difficulty, and domain-specific assurance are three different questions, and a "High" in the first column is never a substitute for doing the integration work implied by the second and third.

---

# 20. Known Limits

TNA should not be presented as infallible. This is not a footnote — it belongs alongside the capabilities above, not after them.

Important boundaries include:

- compromise of the TNA root of trust;
- host compromise below the governed layer;
- malicious or compromised trusted administrators;
- socially engineered legitimate approvals;
- supply-chain changes that bypass the governed path;
- subtle malicious actions that remain inside explicitly authorized boundaries;
- incomplete or untrusted telemetry;
- controls that have not been defined for a new threat class.

TNA is designed to make dangerous agent actions **harder to execute, easier to contain, and harder to conceal**.

It does not eliminate every possible failure mode, and no claim in this document should be read as "proven secure," "guaranteed safe," or "always stops" — every ALLOW/BLOCK/HOLD decision, every containment action, and every verification result here is scoped to a governed path, under stated conditions, subject to the limits above.

---

# 21. Summary

In an OpenAI-like organization, TNA would not be installed "inside the model."

It would become the governance layer surrounding consequential agent execution.

```text
INTENT
  ↓
PROPOSED ACTION
  ↓
AUTHORITY CHECK
  ↓
ALLOW / BLOCK / HOLD
  ↓
BOUNDED CAPABILITY
  ↓
RUNTIME OBSERVATION
  ↓
EXECUTION
  ↓
AUTHORITATIVE EVIDENCE
  ↓
INDEPENDENT VERIFICATION
  ↓
ASSURANCE
```

TNA does not promise that every autonomous action can be perfectly understood or perfectly stopped. It establishes where authority must be checked, where evidence must originate, where containment can occur, where independent verification is required, and where uncertainty must remain uncertainty rather than being mislabeled as safety.

> **Give AI agents real power without giving them uncontrolled power.**

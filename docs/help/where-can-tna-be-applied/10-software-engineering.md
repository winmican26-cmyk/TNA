# TNA Deployment Example — Software Engineering

## Why Software Engineering Is an Ideal Early TNA Use Case

Coding agents can:

- read repositories;
- edit files;
- run tests;
- install dependencies;
- execute shell commands;
- create pull requests;
- merge code;
- deploy services;
- change infrastructure.

That gives them real power.

## Architecture

```text
Coding Agent
    ↓
TNA Gate
    ↓
Capability
    ↓
TNA Sentinel
    ↓
Shell / Git / CI / Deployment Tool
    ↓
TNA Ledger
    ↓
VAD / Control Center
```

## Recommended first pilot

Govern the path from code generation to deployment.

Example:

```text
read repository             → ALLOW
edit assigned workspace     → ALLOW
run bounded tests           → ALLOW
modify protected path       → BLOCK
merge to protected branch   → HOLD
deploy production           → HOLD
change agent permissions    → BLOCK / special approval
```

## Sentinel: why "merge" and "deploy" sit at HOLD, not TERMINATE-after-the-fact

While a coding agent's session is running — editing files, running tests, iterating — that is Sentinel's controllable-execution case: it can genuinely WARN, HOLD, or TERMINATE the session if it strays outside its assigned workspace or attempts something unexpected.

A merge to a protected branch or a production deployment is different: once it completes, the effect is committed — the branch history or the running service has already changed. Sentinel cannot reverse a merge or a deploy after the fact any more than it can undo a sent message elsewhere in this collection; it can only detect, contain, revoke further authority, and prevent the next action. This is exactly why the table above puts both at HOLD *before* execution rather than relying on Sentinel to catch a bad merge or deploy afterward — the governing decision has to happen at Gate.

## VAD: this is the strongest domain fit in the collection for an independent oracle

VAD provides a generic verification protocol; it does not provide a universal truth oracle — but software engineering is the domain in this collection where a strong, concrete oracle is easiest to build, because deterministic checks already exist. Check:

- test results;
- type checking;
- build output;
- security scans;
- artifact hash;
- deployed version;
- health endpoints.

None of these depend on the agent's own report of what it did.

## Recursive improvement

If the coding agent modifies itself or its own toolchain, the change must not silently widen authority.

> **COMPETENCE CHANGE ≠ AUTHORITY CHANGE ≠ CONTROL-PLANE CHANGE**

A better patch, a faster pipeline, or a smarter prompt is a competence change. Adding a tool, widening filesystem scope, or approving its own merge into a protected path is an authority or control-plane change, and must not happen as a silent side effect of the first. This governs successor promotion and authority expansion under defined controls — it is not a claim that self-modifying coding agents have been proven safe in general.

## Ledger

Capture:

- proposed action;
- file/tool target;
- approval;
- command execution;
- test/verification evidence;
- resulting commit/deployment identity.

## Maturity and integration caveats

| TNA Capability | Current Confidence | Caveat |
|---|---|---|
| Gate / authority mediation | High | Must integrate with real Git/CI/deployment-system boundaries |
| Bounded capabilities | High | Distributed issuance/revocation required at scale |
| Ledger / provenance | High | Needs hardened, replicated, independent storage |
| Approval separation | High | Human coercion/social engineering remains possible |
| Sentinel — controllable execution | High within tested execution substrates | Requires an interruptible runtime substrate |
| Sentinel — atomic external effects | Limited after commit | Cannot un-merge or un-deploy once committed |
| VAD framework | High — strongest domain fit in this collection | Still requires real integration with test/build/deploy tooling per repo |
| Recursive Improvement Governance | Strong control architecture | Frontier-scale deployment evidence still needed |

## What TNA does not replace

TNA sits above and between existing control systems as an authorization, containment, evidence, verification, and governance control plane. Passing tests do not prove specification completeness — TNA can govern the workflow without claiming the produced software is universally correct or secure, and it does not replace code review, static analysis, or human engineering judgment.

## Known limits

TNA cannot guarantee safe behavior if the TNA host/root of trust is compromised, trusted administrator credentials are stolen, a legitimate approver acts maliciously or is socially engineered, execution bypasses TNA entirely, trusted telemetry is compromised, harmful behavior stays within explicitly authorized scope, or governing policy does not yet cover the threat class.

No claim above should be read as "proven secure" or "always stops" — each is scoped to the governed path, under stated conditions.

## Example takeaway

> Coding agents can be fast without being allowed to turn every generated change directly into production.

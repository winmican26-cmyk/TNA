# TNA Help — Where Can TNA Be Applied?

This collection provides architectural application examples for Trust No Agent (TNA).

These documents are not claims that any named organization currently uses TNA, nor do they describe private infrastructure. They show how TNA could be applied to common agentic execution patterns using the public-facing characteristics of each environment as a reference.

## Cross-cutting principle

TNA does not promise that every autonomous action can be perfectly understood or perfectly stopped. It establishes where authority must be checked, where evidence must originate, where containment can occur, where independent verification is required, and where uncertainty must remain uncertainty rather than being mislabeled as safety.

**Unknown must never render as safe.**

Four distinctions recur across every page in this collection and are worth stating once, here, rather than only inside each example:

- **A capability authorizes an action; it does not certify that the action is wise, correct, safe, or successful.** Gate answers "is this allowed to happen"; that is a different question from "did it work" or "was it the right call" — the second belongs to VAD, and some questions (see below) don't have a generic verifier at all.
- **Sentinel's reach differs by execution shape.** For controllable, long-running execution (sessions, workflows, containers), Sentinel can genuinely WARN, HOLD, TERMINATE, or contain. For an atomic or already-committed external effect (a sent message, a settled payment, a completed deploy), Sentinel cannot reverse the committed effect — its value there is detection, containment, revocation of future authority, and prevention of the next action.
- **VAD is a protocol, not a truth oracle.** It supplies the workflow — producer, evidence, independent verifier, ACCEPT/REJECT/INDETERMINATE, provenance. Each domain has to supply its own independent evidence source; the harder that is to define, the less confidently an autonomous system should be permitted to claim success.
- **Computer-use / GUI mediation is an emerging, high-risk integration area**, not equal in maturity to Gate or Ledger. Pixels are not authority — a click is not, by itself, evidence of the semantic action it was interpreted to authorize.

Each page below includes a **Maturity and Integration Caveats** table scoped to what is actually relevant in that environment — this is deliberately not one repeated universal table, since implementation maturity, integration difficulty, and domain-specific assurance are three different questions and the answers differ by environment.

## Frontier AI Labs

- [OpenAI](./01-frontier-ai-openai.md)
- [Anthropic / Claude](./02-frontier-ai-anthropic-claude.md)
- [xAI / Grok](./03-frontier-ai-xai-grok.md)
- [Google / Gemini](./04-frontier-ai-google-gemini.md)
- [Other Agent Platforms](./05-frontier-ai-other-agent-platforms.md)

## Industry and Operational Environments

- [Financial Services](./06-financial-services.md)
- [Healthcare](./07-healthcare.md)
- [Government](./08-government.md)
- [Critical Infrastructure](./09-critical-infrastructure.md)
- [Software Engineering](./10-software-engineering.md)
- [Enterprise Automation](./11-enterprise-automation.md)

## Reusable TNA application model

Each application example follows the same questions, adapted to what is actually relevant for that environment — a page may omit a question that doesn't apply rather than force a generic answer:

1. What can the agents do?
2. Where does consequential execution occur?
3. Where should TNA Gate sit?
4. How should Sentinel observe runtime behavior — and where does its authority stop at "committed, not reversible"?
5. What should enter the Ledger?
6. Where should VAD require independent verification, and what is the actual oracle for this domain?
7. How should MCP/tools be mediated?
8. How should self-modification or recursive improvement be governed?
9. What is the safest pilot workload?
10. What does this environment's Maturity and Integration Caveats table look like?
11. What are the known limits, including root-of-trust limitations?
12. What does one governed action look like end-to-end?

# TNA Client Integration v0.1 — Tool Risk Model

## Purpose (§21, §105–107)

Risk classification determines the risk class (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`) for every
governed tool. The classification is deterministic, table-driven, and operator-supplied. Three
absolute rules govern this system:

1. **No LLM judgment (§21).** Classification is a fixed rule table, not a prompt to a language model.
2. **No self-classification (§105).** The client or its MCP server cannot assign or influence its own
   tools' risk class. Classification is an operator-only action.
3. **No trust from MCP description/annotations (§106–107).** An MCP server's `description` field,
   `annotations`, or any self-reported metadata is never used as input to the classification
   decision. The operator supplies the facts; the table computes the class.

## The classification table

```typescript
interface RiskClassificationInput {
  readonly operation: 'read' | 'write' | 'execute';
  readonly network_required: boolean;
  readonly category: RiskCategory;
}

type RiskCategory =
  | 'general'
  | 'financial'
  | 'credential-mutation'
  | 'code-execution'
  | 'filesystem-write'
  | 'deployment';
```

### Deterministic classification rules

The `classifyRisk()` function is the one place these facts become a risk class:

| Condition | Result |
|---|---|
| Category is `deployment`, `code-execution`, or `credential-mutation` | **CRITICAL** |
| Category is `financial` or `filesystem-write` | **HIGH** |
| Operation is `write` AND network required | **HIGH** |
| Operation is `write` or `execute` | **MEDIUM** |
| Operation is `read` AND network required | **MEDIUM** |
| All other cases (read, no network, general category) | **LOW** |

Rules are evaluated top to bottom; the first matching condition determines the class. This is a
monotonic priority — a more dangerous condition always overrides a less dangerous one.

## The operator's role

An operator supplies three facts about each tool:

1. **Operation shape** — is this tool primarily reading, writing, or executing?
2. **Network requirement** — does the tool require network access?
3. **Category** — what domain does the tool operate in?

The operator obtains these facts through their own review of the MCP server's documentation, the
tool's schema, and the tool's behavior — not from the MCP server's self-description. This is the
explicit review step that sits between `DISCOVERED` and `ENABLED`.

## Why not trust the MCP server's self-description?

An MCP server is external code (§116). It could:
- Describe a `write` tool as `read` in its annotations
- Omit the network requirement from its description
- Misrepresent its category
- Change its description between discovery rounds

TNA's risk model treats the MCP server's metadata the same way it treats any untrusted input: useful
for display, never trusted for a security decision.

## Risk class vocabulary

```typescript
const RISK_CLASSIFICATIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
```

| Class | Meaning |
|---|---|
| `LOW` | Read-only, no network, general category |
| `MEDIUM` | Some mutation or network access |
| `HIGH` | Financial, filesystem-write, or network-write |
| `CRITICAL` | Deployment, code execution, or credential mutation |

## Relationship to policy binding

When an operator enables a tool via `enableTool`, they supply the `risk_class` from this table. The
risk class is then:
- Stored on the `GovernedToolDefinition`
- Included in the `ToolPolicyBinding`
- Used to determine approval mode, verification requirements, and runtime limits

## Relationship to Gate/Sentinel

The risk class does not directly modify Gate or Sentinel behavior in v0.1 — it informs the operator's
policy decisions (human-approval requirements, VAD verification), which in turn affect how the
platform orchestrates the action. Future volumes may use the risk class for more automated policy
routing.

# TNA Client Integration v0.1 — Onboarding Readiness

## Purpose (§51, §118–119, §123)

Onboarding readiness assessment answers a specific question: "Is this tenant's integration
configuration complete and safe enough to begin processing real actions?" The assessment is honest —
it reports limitations it knows about, acknowledges limitations it cannot detect, and never claims
readiness it has not verified.

## Readiness vocabulary

```typescript
const ONBOARDING_READINESS = ['READY', 'READY_WITH_LIMITATIONS', 'NOT_READY', 'INSUFFICIENT_EVIDENCE'] as const;
```

| Status | Meaning |
|---|---|
| `READY` | All checklist items pass; no known limitations |
| `READY_WITH_LIMITATIONS` | Core items pass but known limitations exist (documented, not hidden) |
| `NOT_READY` | One or more mandatory items fail |
| `INSUFFICIENT_EVIDENCE` | Cannot determine readiness — required evidence is missing |

## Readiness checklist (§51)

A tenant's onboarding readiness is assessed against:

| # | Check | Mandatory? |
|---|---|---|
| 1 | Tenant status is `ACTIVE` | Yes |
| 2 | At least one `ACTIVE` service identity exists | Yes |
| 3 | At least one MCP server is registered | Yes |
| 4 | At least one MCP server is `REACHABLE` (discovery succeeded at least once) | Yes |
| 5 | At least one governed tool is `ENABLED` | Yes |
| 6 | Every `ENABLED` tool has a policy binding | Yes |
| 7 | No `ENABLED` tool has a stale schema (drift detected but not re-reviewed) | Yes |
| 8 | No `POLICY_REVIEW_REQUIRED` tools exist (all drift resolved) | Recommended |

## Bypass assessment (§118–119)

```typescript
const BYPASS_ASSESSMENTS = ['NO_KNOWN_BYPASS', 'KNOWN_BYPASS', 'UNKNOWN'] as const;
```

| Status | Meaning |
|---|---|
| `NO_KNOWN_BYPASS` | No known way to circumvent this tenant's controls within TNA's own boundary |
| `KNOWN_BYPASS` | A documented bypass exists — see the bypass description for details |
| `UNKNOWN` | Cannot determine — insufficient evidence to assess |

### KNOWN_BYPASS meaning (§119)

`KNOWN_BYPASS` does not mean the system is broken. It means a documented limitation exists that an
adversary with the right access could exploit. The two permanent known bypasses for v0.1 are:

1. **§116 — MCP server is external code.** The MCP server process runs arbitrary code. TNA governs
   the *interface* (what tools are called, with what arguments, under what policy) but cannot govern
   the server's internal behavior. A malicious MCP server could perform actions TNA does not observe.

2. **§117 — Client environment bypass.** If the client's own host is compromised, every control that
   depends on the integrity of that environment (credential storage, MCP server binary identity,
   environment isolation) can be bypassed.

These are not bugs — they are fundamental boundaries of an application-level control system. They are
documented prominently in the overview, the threat model, and this assessment.

## Honest limitations (§123)

The readiness assessment is honest about what it can and cannot verify:

**Can verify:**
- Tenant status and service identity existence (direct database query)
- MCP server registration and reachability status (stored from last discovery)
- Tool review status, enablement, and policy binding (direct database query)

**Cannot verify:**
- Whether the MCP server binary is the same one that was reviewed (no binary attestation in v0.1)
- Whether the operator's risk classification is accurate (the table is deterministic but the inputs
  are the operator's judgment)
- Whether the client's credential is stored securely on the client side
- Whether the MCP server's behavior matches its schema (schema is a contract, not enforcement)

The assessment reports `READY_WITH_LIMITATIONS` when core checks pass but these fundamental
limitations apply — which they always do in v0.1.

## Relationship to the platform

Onboarding readiness is assessed at the client integration layer, before an action enters the
platform. The platform has its own readiness model (deployment health). Both must be satisfied for
end-to-end operation: the client integration layer must be ready (this assessment), and the platform
must be ready (deployment health checks).

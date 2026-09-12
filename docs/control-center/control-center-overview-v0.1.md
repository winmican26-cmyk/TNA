# TNA Client Control Center & Assurance UI v0.1 — Overview

## What this is

A browser-based console that lets a TNA client tenant inspect and interact with governed AI-agent activity
that already happened, or is already governed, by the accepted TNA backend stack (Platform, Gate, Sentinel,
Ledger, Auditor, Client Gateway, Improvement Governor). It is a **presentation and confirmation layer**, not
a new authority.

## The permanent rule

> The UI may request, display, explain, and confirm. It may never manufacture authority or evidence.
>
> If the UI says something happened, that statement must trace to authoritative backend state or evidence
> produced by the component that actually performed or observed it.

## Architecture

```
BROWSER -> authenticated Control Center API (BFF) -> existing accepted backend service -> Gate/Sentinel/... -> Ledger evidence
```

Never:

```
BROWSER -> CONTROL CENTER -> "UI SAYS IT IS SAFE"
```

The Control Center (`apps/tna-control-center`, the BFF; `apps/tna-control-center-web`, the browser
frontend) holds no authority of its own. It authenticates a human client user via a session cookie, resolves
their tenant from that session (never from a request parameter), and proxies to already-accepted backend
services using server-held bearer tokens the browser never sees.

## Product surfaces (v0.1)

| Surface | Backend | Status |
|---|---|---|
| Dashboard / Actions / Approval | `apps/tna-platform` | Real |
| Connections / MCP | `apps/tna-client-gateway` | Real (read + real schema-drift display) |
| Governed Tools + schema drift | `apps/tna-client-gateway` | Real |
| Evidence Explorer | `apps/tna-ledger` | Real |
| Audit / Assurance | `apps/tna-auditor` | Real |
| Recursive Improvement lineage | `apps/tna-improvement-governor` | Real |
| Incidents | Live aggregation over the above | Real, non-persistent (see `evidence-visualization-v0.1.md`) |
| Identity / credential lifecycle | `apps/tna-client-gateway` | Real |
| Onboarding wizard | Mixed — see `client-onboarding-ui-v0.1.md` | Real where an accepted client-facing capability exists |
| Notifications | Polling over the above | Real, no new backend |

## What this is not

- Not the TNA Operator CLI/Console, and does not replace it.
- `client-admin` is a Control-Center-scoped role; it is never TNA-operator authority.
- Does not certify legal, regulatory, contractual, or industry compliance (see the Audit page's own
  disclaimer).
- Does not prove system safety — it displays evidence a human or auditor can review.

## Companion documents

`client-role-model-v0.1.md`, `frontend-security-boundary-v0.1.md`, `evidence-visualization-v0.1.md`,
`approval-ux-v0.1.md`, `recursive-improvement-ui-v0.1.md`, `client-onboarding-ui-v0.1.md`,
`control-center-threat-model-v0.1.md`, `control-center-verification-v0.1.md`,
`control-center-requirement-matrix-v0.1.md`, `client-user-guide-v0.1.md`,
`proof-of-work-control-center-v0.1.md`. The foundation review
(`control-center-foundation-review-v0.1.md`) remains as historical/supporting documentation of the
mid-project security checkpoint.

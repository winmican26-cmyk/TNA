# Client Onboarding UI v0.1

## The ten-step sequence and what is real

| # | Step | Classification | Real? |
|---|---|---|---|
| 1 | Organization | A — real `GET /api/organization` (Client Gateway `ClientTenant`) | Yes |
| 2 | Service identity | A — real create/list via Client Gateway | Yes |
| 3 | Connection / MCP | **B** — registration/discovery exist at Client Gateway but are operator-only by design (see below); read-only view is real | View: yes; register/discover: no |
| 4 | Tool discovery | View of real `DISCOVERED` tools is real; triggering NEW discovery is category B | View: yes |
| 5 | Tool review | A — real Tools page | Yes |
| 6 | Risk / policy | A — real, set at the moment of enabling (`tool.enable.request`) | Yes |
| 7 | Test action | **C** — no accepted capability; a browser session structurally cannot mint an agent token | No |
| 8 | Evidence verification | A — real Evidence Explorer | Yes |
| 9 | Bypass assessment | **C** — no accepted HTTP capability anywhere (only a free-text operator-CLI field) | No |
| 10 | Readiness | A — real `GET /api/readiness` (`assessOnboardingReadiness`) | Yes |

## Classification rule (build-order item 1)

- **A**: an accepted backend capability can be safely exposed via a narrow BFF route without redesigning
  the control plane. Implemented.
- **B**: the capability exists in an accepted backend but is operator-only by design. Left as an explicit
  "not available in this client console" notice, with the reason stated.
- **C**: no accepted capability exists anywhere. Left as an explicit "not available" notice — never
  fabricated.

## Why steps 3-4 (MCP registration/discovery) are category B, not A

Registering a new MCP server means telling a real backend to spawn a specific executable path as a child
process — new infrastructure a TNA agent will subsequently run. The Volume 13 kickoff's own reviewed
permission matrix (`permissions.ts`) grants `connection.read` to every role and grants NO
`connection.create`/`connection.manage` permission to any role, including `client-admin`. This mirrors
Platform's own agent-token/operator-token split (an agent identity is provisioned by an operator, never
self-service). Adding a permission here would mean re-opening the already-reviewed foundation security
model outside the review process that settled it — out of scope for a "close remaining gaps where safe"
pass. **Discovery of already-registered servers' governed tools is what step 4 shows; step 3's own
registration/discovery-trigger action remains operator-tooling.**

## Why step 7 (test action) is category C

Platform's own authorization path requires `request.agent_id === principal.agentId` — the AUTHENTICATED
agent token's own bound identity. A browser session authenticates a human CLIENT identity, never an agent
identity, and structurally cannot mint or hold an agent token (the same reason `platform_operator_token`
never reaches the browser). Submitting a real test action requires the client's own integrated agent's SDK
credential, not this console.

## Why step 9 (bypass assessment) is category C

`bypass_assessment` exists only as a free-text field in the operator CLI's handoff document
(`apps/tna-operator/src/handoff.ts`) — there is no queryable computation or HTTP route for it in any
accepted backend.

## Discovery never implies authorization

A newly discovered tool always starts `DISCOVERED`, disabled, and requires an explicit risk classification
and policy id before it can ever be enabled (`tool.enable.request`, real backend-validated). There is no
"enable all discovered tools" action anywhere in this console.

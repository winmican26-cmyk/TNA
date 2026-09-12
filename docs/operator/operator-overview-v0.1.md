# TNA Operator Readiness & Deployment Academy v0.1 — Overview

Volumes 1–10 proved TNA can authorize, enforce, monitor, verify, record, audit, deploy, recover, onboard
a real client, and mediate real MCP execution. Volume 11 asks a different question: **can a competent
person who did not build TNA operate it** — deploy it, onboard a client, run it day to day, recognize
unsafe states, respond to incidents, and hand it over to someone else — using only supported interfaces
and documented procedures, never source-code edits or ad hoc database surgery?

## What Volume 11 builds

1. **The `tna` operator CLI** (`apps/tna-operator`) — a real command-line client over the already-
   accepted admin/operator HTTP surfaces of `apps/tna-platform` and `apps/tna-client-gateway`. It never
   touches a database directly.
2. **Operator diagnostics and incident tooling** — `tna doctor` (read-only health aggregation) and
   `tna incident collect` (a hashed, redacted, tenant-scoped support package).
3. **Client go-live assessment and handoff** — `ClientGoLiveAssessment v1` and
   `ClientDeploymentHandoff v1`, both deterministic and evidence-bound.
4. **A real, reduced Deployment Academy** (`academy/`) — a curriculum structure, a principles map, and a
   small set of real, deterministically-verified hands-on labs run against actual TNA code.

## What Volume 11 does not build

Billing, Stripe, subscriptions, a marketing site, a full customer-facing SaaS portal, multi-region
infrastructure, a Kubernetes production platform, enterprise SSO/SCIM, a CRM, sales automation, support
ticketing, or a mobile application. It does not redesign Gate, VAD, Ledger, Sentinel, Auditor, Platform,
Deployment, or Client Integration — it sits above that accepted architecture and calls it through its own
existing interfaces.

## Honest scope statement

This is a first, real implementation pass, not full coverage of every item the original Volume 11 brief
described. The operator CLI, diagnostics, incident tooling, and go-live/handoff machinery are complete
and tested. The Deployment Academy is real but intentionally smaller than the full four-level, fifteen-
lab curriculum described in the brief. See
[proof-of-work-operator-v0.1.md](proof-of-work-operator-v0.1.md)'s "Remaining Limitations" for the exact
accounting of what exists and what does not yet.

## Document set

- [operator-cli-v0.1.md](operator-cli-v0.1.md) — command reference, exit codes, JSON output contract
- [operator-auth-v0.1.md](operator-auth-v0.1.md) — role model and authority boundaries
- [operator-diagnostics-v0.1.md](operator-diagnostics-v0.1.md) — `tna doctor`
- [operator-incidents-v0.1.md](operator-incidents-v0.1.md) — incident scenarios and CLI behavior
- [operator-support-bundle-v0.1.md](operator-support-bundle-v0.1.md) — incident package format and redaction
- [client-deployment-checklist-v0.1.md](client-deployment-checklist-v0.1.md)
- [client-go-live-v0.1.md](client-go-live-v0.1.md)
- [client-handoff-v0.1.md](client-handoff-v0.1.md)
- [operator-threat-model-v0.1.md](operator-threat-model-v0.1.md)
- [operator-verification-v0.1.md](operator-verification-v0.1.md)
- [operator-requirement-matrix-v0.1.md](operator-requirement-matrix-v0.1.md)
- [proof-of-work-operator-v0.1.md](proof-of-work-operator-v0.1.md)
- [operator-runbook-v0.1.md](operator-runbook-v0.1.md)

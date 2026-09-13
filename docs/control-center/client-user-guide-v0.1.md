# TNA Client Control Center — User Guide v0.1

## Signing in

Your organization's client-admin creates your account and sends you a one-time signup link (`/signup?token=...`),
or your TNA operator provisions you directly out of band. There is still no open, public signup — every
account is tied to a specific tenant and role chosen by whoever created it; a signup link only ever lets you
choose your own password. If you forget your password, ask a client-admin on your team for a reset link
(`/reset-password?token=...`) — this console sends no email itself, so the link is delivered to you however
your admin normally reaches you. Sign in at the Control Center's URL. The banner at the top of the screen
always shows the real environment (`DEVELOPMENT`/`STAGING`/`PRODUCTION`) — check it before approving anything.

## What you can do, by role

- **client-viewer**: see everything (dashboard, actions, connections, tools, evidence, audit, incidents,
  improvements, identities, onboarding status). Cannot change anything.
- **client-auditor**: viewer's visibility, plus acknowledging incidents.
- **client-reviewer**: viewer's visibility, plus approving/rejecting/terminating held or blocked actions.
- **client-admin**: reviewer's capability, plus tool enable/disable requests, identity/credential lifecycle,
  organization settings, and improvement approve/promote/rollback.

If a button you expect is missing, your role does not have that permission — this is enforced by the real
backend, not just hidden in your browser.

## Key pages

- **Overview**: real assurance/component health and action counts.
- **Actions**: every governed action; click one for full detail and evidence. HELD actions await your
  approval if your role allows it.
- **Connections**: your tenant's registered MCP servers and their real status (CONNECTED / DEGRADED /
  UNAVAILABLE / UNKNOWN — UNKNOWN is never shown as healthy).
- **Tools**: governed tools discovered from your connections. A tool whose contract changed shows a "TOOL
  CONTRACT CHANGED" banner and is automatically disabled pending your review — this is real backend state,
  not a suggestion.
- **Evidence**: search the tamper-evident Ledger; verify any stream's integrity on demand.
- **Audit**: assessment results against configured controls. This does not certify legal, regulatory, or
  compliance status — read the disclaimer on the page.
- **Improvements**: the lineage of recursive-improvement generations for a system. A promoted successor is
  never automatically more powerful than its parent — check the Authority panel, not just the status badge.
- **Incidents**: real, live conditions (unavailable components, Ledger integrity problems, schema drift,
  unreachable connections). This is not a persisted incident ticket system — acknowledging one records that
  you saw it, not that it is resolved.
- **Identities**: service identities and their credentials. A freshly issued or rotated credential is shown
  to you exactly once — copy it immediately; it cannot be shown again.
- **Onboarding**: a guided walkthrough. A few steps (registering new MCP servers, submitting a test action,
  bypass assessment) are explicitly marked unavailable in this console — they require your TNA operator or
  your own agent's credentials.
- **Team** (client-admin only): invite a teammate (fixing their username and role) and get a one-time
  signup link, or generate a one-time password-reset link for an existing teammate. Copy the link and
  deliver it yourself — no email is sent by this console.

## What this console will never do

- Never shows a status as healthy/verified/passing when the real backend says otherwise, or when the
  backend's answer is unrecognized.
- Never marks something approved, promoted, rolled back, enabled, or active before the real backend confirms
  it.
- Never lets third-party or candidate-supplied text visually pass itself off as a TNA decision.
- Never gives you TNA-operator authority — for anything this console says is unavailable, contact your TNA
  operator.

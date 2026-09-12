# TNA Operator Runbook v0.1

The authoritative human operations entrypoint for TNA. Each chapter names the real command or document
that answers it — this runbook is an index into real, tested behavior, not a standalone narrative.

## 1. What TNA is

TNA governs what an AI agent is allowed to do, watches it while it runs, verifies what it produced,
records durable evidence of all of it, audits that evidence after the fact, and now — as of this volume
— can be deployed, operated, diagnosed, and handed over by someone who did not build it. See the root
[README.md](../../README.md) for the full volume-by-volume architecture.

## 2. Control-plane overview

Gate authorizes → Capability is issued → Sentinel monitors → the Execution Broker mediates the real
tool/MCP call → VAD optionally verifies the result → Ledger records evidence → Auditor assesses it
after the fact. `apps/tna-platform` orchestrates all of this for one request;
`apps/tna-client-gateway` does the same for a real external client's MCP tools.

## 3. Installing

`npm ci` from the repository root. Node.js 24+ required (`engines` in `package.json`).

## 4. Initializing

`npm run tna:init` (Volume 9, unchanged) for the standalone platform; `TNA_CLIENT_*` environment
variables for the client gateway (see `apps/tna-client-gateway/src/config.ts`).

## 5. Starting

`npm run start:platform`, `npm run start:client-gateway` — real, compiled production entrypoints.

## 6. Health verification

`tna status`, `tna health`, `tna doctor` — see
[operator-diagnostics-v0.1.md](operator-diagnostics-v0.1.md).

## 7. Client onboarding

`tna tenant create` → `tna tenant activate` → `tna service create`. See
[client-deployment-checklist-v0.1.md](client-deployment-checklist-v0.1.md) for the full sequence.

## 8. MCP registration

`tna mcp register --tenant <id> --input '{...}'`.

## 9. Tool discovery

`tna mcp discover --tenant <id> <server-id>`.

## 10. Tool review

`tna tool list` / `tna tool inspect` — a discovered tool is never auto-enabled (TNA-58).

## 11. Policy binding

`tna tool enable --tenant <id> <tool-id> --input '{...}'` — HIGH/CRITICAL risk requires
`security-operator` and `--reason`.

## 12. Action execution

Governed actions flow through the client's own real application traffic against
`POST /v1/client/actions` on the packaged gateway — the operator CLI observes and governs this, it does
not submit ordinary client traffic itself.

## 13. Holds

`tna hold list` / `tna hold inspect` / `tna hold approve` / `tna hold reject` — both mutating commands
require `--reason`; approval refuses self-approval.

## 14. Terminations

`tna hold reject <action-id> --reason "..."` also covers explicit termination of an in-flight action
(`PlatformControlOrchestrator.terminate`).

## 15. Evidence

`tna action evidence` / `tna action reconstruct` — real durable reconstruction, with causal ids.

## 16. Audit

`tna audit run <action-id>` — runs the platform's own accepted post-hoc Auditor integration for that one
action.

## 17. Credential rotation

`tna service rotate --tenant <id> <service-id> --state-version <n>` — shows the new credential once.

## 18. Suspension

`tna tenant suspend --tenant <id> --reason "..."`.

## 19. Offboarding

`tna tenant offboard --tenant <id> --reason "..." --confirm <id>` (admin only).

## 20. Backup

Volume 9's `npm run tna:backup` — unchanged, not yet wrapped by a `tna` subcommand in this pass.

## 21. Restore

Volume 9's `npm run tna:restore` — unchanged, not yet wrapped by a `tna` subcommand in this pass.

## 22. Upgrade

Unchanged from Volume 9 — see `docs/deployment/`.

## 23. Rollback

Unchanged from Volume 9 — restoring a known-good backup, never an in-place schema downgrade.

## 24. Incident response

`tna doctor` → `tna incident collect` → review → escalate. See
[operator-incidents-v0.1.md](operator-incidents-v0.1.md).

## 25. Troubleshooting

`tna action explain <id>` for any action in an unexpected state; `tna doctor` for any subsystem-level
degradation.

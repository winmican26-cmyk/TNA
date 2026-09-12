# TNA Operator CLI v0.1

## Invocation

```
node dist/apps/tna-operator/src/main.js <command> [subcommand] [args] [flags]
```

or, once `npm run build` has run, via the `tna:cli` npm script:

```
npm run tna:cli -- <command> ...
```

Every command requires `--profile <name>` (or `TNA_OPERATOR_PROFILE`), resolving a profile file under
`~/.tna/profiles/<name>.json` (or `TNA_OPERATOR_PROFILE_DIR`). See
[operator-auth-v0.1.md](operator-auth-v0.1.md) for the profile format and role model.

## Global flags

| Flag | Meaning |
|---|---|
| `--profile <name>` | Which operator profile to use |
| `--json` | Emit `OperatorCommandResult v1` JSON instead of human-readable text |
| `--tenant <id>` | Tenant scope for tenant-scoped commands |
| `--reason "<why>"` | Required for sensitive commands (see below) |
| `--input '<json>'` | Raw JSON body for create/enable-style commands |
| `--state-version <n>` | Expected CAS version for update-style commands |
| `--confirm <id>` | Exact tenant-id confirmation required for `tenant offboard` |

## Commands (implemented in v0.1)

| Command | Role | Notes |
|---|---|---|
| `status` / `health` | viewer | Aggregated `/ready` from configured subsystems |
| `doctor` | viewer | Read-only diagnostics — see [operator-diagnostics-v0.1.md](operator-diagnostics-v0.1.md) |
| `tenant list` / `tenant show` | viewer | |
| `tenant create` | operator | |
| `tenant activate` | operator | PENDING → ACTIVE |
| `tenant suspend` | operator | requires `--reason` |
| `tenant offboard` | admin | requires `--reason` and `--confirm <exact-tenant-id>` |
| `service list` | viewer | |
| `service create` | operator | shows the one-time credential (not redacted — see below) |
| `service rotate` | operator | shows the new one-time credential |
| `service revoke` | security-operator | |
| `mcp list` / `mcp inspect` | viewer | |
| `mcp register` | operator | |
| `mcp discover` | operator | |
| `tool list` / `tool inspect` | viewer | |
| `tool enable` | operator (security-operator if `risk_class` is HIGH/CRITICAL) | requires `--reason` when risk is HIGH/CRITICAL |
| `tool disable` | operator | |
| `action list` / `action show` / `action evidence` / `action reconstruct` / `action explain` | viewer | see below |
| `hold list` / `hold inspect` | viewer | |
| `hold approve` | operator | requires `--reason`; refuses self-approval |
| `hold reject` | security-operator | requires `--reason` |
| `incident status` | viewer | |
| `incident collect` | operator | see [operator-support-bundle-v0.1.md](operator-support-bundle-v0.1.md) |
| `audit run` / `audit show` | operator / viewer | per-action audit via the platform's own `/audit` route |
| `go-live assess` | operator | see [client-go-live-v0.1.md](client-go-live-v0.1.md) |
| `handoff generate` | admin | see [client-handoff-v0.1.md](client-handoff-v0.1.md) |
| `deployment status` | viewer | platform diagnostics summary |

**Not implemented in v0.1**: `tenant reactivate` (SUSPENDED → ACTIVE) — `ClientStore.resumeTenant` exists
and is tested at the library level, but no HTTP route for it was ever exposed by the accepted Volume 10
client gateway, and this volume does not redesign Client Integration to add one.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 2 | VALIDATION_ERROR |
| 3 | FORBIDDEN |
| 4 | UNAVAILABLE |
| 5 | FAILED |
| 6 | INDETERMINATE |
| 7 | NOT_FOUND |

## `OperatorCommandResult v1`

```json
{ "version": "1.0", "ok": true, "code": "OK", "summary": "...", "data": { }, "warnings": [] }
```

`--json` output is deep-redacted before printing (see [operator-support-bundle-v0.1.md](operator-support-bundle-v0.1.md#redaction))
except for the one-time credential display of `service create`/`service rotate`, whose entire purpose is
showing that value exactly once (carried forward from Volume 10's own "shown once" contract).

## `action show` field summary

`action show` prints: action id, tenant, tool, Gate decision, capability status, Sentinel status,
execution outcome, VAD outcome, evidence state, audit state, and correlation id — not every internal
JSON field. Use `action evidence`/`action reconstruct` for the full causal reconstruction.

## `action explain`

Deterministic, rules-based (`apps/tna-operator/src/explain.ts`) — no LLM decides what actually happened.
Translates `error_code`/Gate-block-reason into an operator-facing headline, detail, and guidance, always
alongside the original machine code (never concealed).

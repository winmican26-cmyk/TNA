# TNA Operator CLI v0.1 — Authentication and Authorization

## Two layers of authority

1. **Server-side (real, accepted, unchanged)**: `apps/tna-platform` and `apps/tna-client-gateway` each
   enforce their own bearer-token authentication and role checks exactly as accepted in Volumes 8 and
   10. The operator CLI never bypasses this — every mutating request still goes through the same
   `Authorization: Bearer <token>` check those servers already had.
2. **Client-side (new in this volume, additive)**: an explicit, closed operator role
   (`apps/tna-operator/src/roles.ts`) gates which CLI commands a profile may even attempt, refusing
   locally — before any HTTP request is made — for a command the profile's role does not permit. This
   layer exists to give operators a clear, local, pre-flight refusal and an audit trail entry, not to
   grant any authority the server itself would refuse.

## Roles

`viewer` < `operator` < `security-operator` < `admin` (total order). See
[operator-cli-v0.1.md](operator-cli-v0.1.md)'s command table for the minimum role each command requires.
High-risk actions (tenant offboarding, credential revocation, hold rejection/termination, enabling a
HIGH/CRITICAL-risk tool) require `security-operator` or `admin` — never merely `operator`.

## Profiles

A profile is a JSON file under `~/.tna/profiles/<name>.json` (or `TNA_OPERATOR_PROFILE_DIR`):

```json
{
  "role": "operator",
  "devMode": false,
  "platformUrl": "https://platform.example.com",
  "platformTokenEnv": "TNA_OPERATOR_PLATFORM_TOKEN",
  "clientGatewayUrl": "https://gateway.example.com",
  "clientGatewayAdminTokenEnv": "TNA_OPERATOR_GATEWAY_TOKEN"
}
```

The profile file references **environment variable names**, never raw secrets — `resolveCredential`
reads the actual bearer token from the named environment variable at invocation time, never from the
profile file itself.

## TLS (section 80-81)

A non-`https://` `platformUrl`/`clientGatewayUrl` is refused outright unless the profile sets
`"devMode": true` explicitly. There is no silent downgrade path.

## No self-approval

`hold approve` compares the resuming operator's profile name against the action's own `created_by`
field and refuses (`FORBIDDEN`) if they match — an additive CLI-side guard, since the platform's
Sentinel-driven HOLD/resume path (`PlatformControlOrchestrator.resume`) has no such check of its own
(Gate's own separate approver-role separation, accepted since Volume 1, already covers Gate-level
approvals and is untouched here).

## Reason requirement

`--reason "<why>"` is required for: `tenant suspend`, `tenant offboard`, `tool enable` when risk is
HIGH/CRITICAL, `hold approve`, `hold reject`. The reason is written to the local operator audit log
(`apps/tna-operator/src/audit-log.ts`) alongside actor, role, target, tenant, before/after state, and
timestamp — a real, durable, local SQLite record distinct from (and additive to) whatever evidence the
called subsystem itself records.

## Wrong-tenant safety

`tenant offboard` additionally requires `--confirm <exact-tenant-id>` matching `--tenant` byte-for-byte
— a fat-finger guard against offboarding the wrong tenant.

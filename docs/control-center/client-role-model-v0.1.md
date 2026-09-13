# Client Role Model v0.1

## The invariant

```
ROLE -> PERMISSIONS -> SERVER-SIDE AUTHORIZATION
```

never

```
ROLE -> UI BUTTON VISIBILITY
```

Every mutating (and every sensitive read) route calls `authorizeClientPermission(role, permission)`
(`apps/tna-control-center/src/permissions.ts`) — the single, centralized matrix. No route handler contains
an inline `if (role === 'client-admin')` check. The frontend consults the SAME permission list (returned by
`GET /api/session/me`) only to decide what to show — hiding a button is UX; the 403 on the real route is the
actual control (proven directly in `tests/control-center/role-matrix.test.ts` and
`security.test.ts`'s "hidden button is never the actual security control" test).

## Roles

| Role | Reads | Mutations |
|---|---|---|
| `client-viewer` | Everything (`action.read`, `evidence.read`, `audit.read`, `incident.read`, `tool.read`, `connection.read`, `identity.read`, `improvement.read`, `organization.read`) | None |
| `client-auditor` | Same reads as viewer | `incident.acknowledge` only (not an authority-changing mutation) |
| `client-reviewer` | Same reads as viewer | `action.approve`, `action.reject`, `action.terminate` |
| `client-admin` | Same reads as viewer | Reviewer's set, plus `tool.enable.request`, `tool.disable.request`, `identity.create`, `identity.suspend`, `credential.rotate`, `improvement.approve`, `improvement.promote`, `improvement.rollback`, `organization.manage`, `user.invite`, `user.reset_password` |

`user.invite`/`user.reset_password` govern Control-Center HUMAN logins (`ControlCenterUser`) — a distinct
resource from `identity.*`, which governs Client Gateway SERVICE identities. Both are real, admin-issued,
single-use, expiring tokens (no email integration exists anywhere in this project); see
`session-store.ts` for the full design.

**`client-admin` never receives a TNA-operator-only capability.** There is no permission in this matrix, at
any role, that maps to an operator-only Platform/Gate/Sentinel/Ledger/Improvement-Governor route (Platform's
`platform_operator_token`, the Improvement Governor's real `improvement-approver` Gate role, etc. are held
server-side only and never exposed to any client role — see `control-center-threat-model-v0.1.md`, finding
5).

## Multi-session semantics (deliberate, not a bug)

A new login creates a new, independently random, expiring, and revocable session. It does not invalidate a
user's other valid sessions. Each session is independently destroyable (`destroySession` takes the specific
session id, never "all sessions for this user"). Do not describe login as global session rotation unless
that behavior is actually added.

## Tenant resolution

A session's `tenant_id` is fixed at login and is the ONLY source of tenant identity for every subsequent
request — never a query parameter, request body field, path segment, or header. A request that names a
different tenant anywhere in it is silently ignored, not honored (proven in `tenant-boundary.test.ts`).

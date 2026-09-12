import type { ClientRole } from './schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), foundation-review sections 13-17. The single
 * authoritative client-role permission matrix. Every server-side route MUST consult
 * `authorizeClientPermission()` — never re-implement a role check inline (the forbidden pattern this
 * module replaces: `if (role === 'client-admin')` scattered across route handlers). The invariant this
 * enforces:
 *
 *     ROLE -> PERMISSIONS -> SERVER-SIDE AUTHORIZATION
 *
 * never `ROLE -> UI BUTTON VISIBILITY`. This matrix is deliberately defined for the FULL permission
 * surface the kickoff brief names, even though most of these permissions have no HTTP route wired to them
 * yet in this increment (evidence/audit/incident/tool/connection/identity/improvement/organization pages
 * are future Volume 13 work) — settling the matrix now means every future route has an unambiguous,
 * already-reviewed answer to consult rather than inventing its own ad hoc check later.
 */

export const CLIENT_PERMISSIONS = [
  'action.read', 'action.approve', 'action.reject', 'action.terminate',
  'evidence.read',
  'audit.read',
  'incident.read', 'incident.acknowledge',
  'tool.read', 'tool.enable.request', 'tool.disable.request',
  'connection.read',
  'identity.read', 'identity.create', 'identity.suspend', 'credential.rotate',
  'improvement.read', 'improvement.approve', 'improvement.promote', 'improvement.rollback',
  'organization.read', 'organization.manage',
] as const;
export type ClientPermission = typeof CLIENT_PERMISSIONS[number];

const READ_PERMISSIONS: readonly ClientPermission[] = [
  'action.read', 'evidence.read', 'audit.read', 'incident.read', 'tool.read', 'connection.read',
  'identity.read', 'improvement.read', 'organization.read',
];

/**
 * The authoritative matrix (foundation-review section 15):
 *
 * - `client-viewer`: every read permission. No mutations at all.
 * - `client-auditor`: the same reads as viewer (evidence/audit/incident visibility is exactly what an
 *   auditor role is for) plus `incident.acknowledge` (acknowledging is not an authority-changing
 *   mutation — it does not approve, promote, rollback, or alter anything Gate/Sentinel/Ledger enforce).
 *   No authority-changing mutation of any kind.
 * - `client-reviewer`: viewer's reads plus the action-review mutations (`approve`/`reject`/`terminate`)
 *   the kickoff brief scopes to this role. No tenant-administration, tool-management, identity, or
 *   improvement-promotion authority.
 * - `client-admin`: reviewer's full set plus tenant administration (tool enable/disable REQUESTS —
 *   never a guaranteed grant, since Platform itself may still require higher, operator-only authority;
 *   see `platform-client.ts`'s operator-token routes — identity lifecycle, credential rotation,
 *   organization management) and improvement approve/promote/rollback. `client-admin` is explicitly NOT
 *   given any TNA-operator-only capability (foundation-review section 15's closing rule) — there is no
 *   permission in this matrix, at any role, that maps to an operator-only Platform/Gate/Sentinel/Ledger
 *   /Improvement-Governor route.
 */
const ROLE_PERMISSIONS: Readonly<Record<ClientRole, ReadonlySet<ClientPermission>>> = {
  'client-viewer': new Set(READ_PERMISSIONS),
  'client-auditor': new Set([...READ_PERMISSIONS, 'incident.acknowledge']),
  'client-reviewer': new Set([...READ_PERMISSIONS, 'action.approve', 'action.reject', 'action.terminate']),
  'client-admin': new Set([
    ...READ_PERMISSIONS, 'action.approve', 'action.reject', 'action.terminate', 'incident.acknowledge',
    'tool.enable.request', 'tool.disable.request', 'identity.create', 'identity.suspend', 'credential.rotate',
    'improvement.approve', 'improvement.promote', 'improvement.rollback', 'organization.manage',
  ]),
};

export class PermissionDeniedError extends Error {
  public constructor(public readonly permission: ClientPermission, public readonly role: ClientRole) {
    super(`Role ${role} does not have permission ${permission}`);
    this.name = 'PermissionDeniedError';
  }
}

export function roleHasPermission(role: ClientRole, permission: ClientPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** The one function every route handler calls. Throws `PermissionDeniedError` (mapped to HTTP 403 by the
 * server's error mapping) rather than returning a boolean — a route cannot accidentally forget to check
 * the return value the way it could with a boolean helper. */
export function authorizeClientPermission(role: ClientRole, permission: ClientPermission): void {
  if (!roleHasPermission(role, permission)) throw new PermissionDeniedError(permission, role);
}

/** Returns the full permission set for a role — used by the frontend's `GET /api/session/me` response so
 * the UI can decide what to SHOW (section 5: hiding a button is UX, never the security control itself;
 * the server-side `authorizeClientPermission` call on the actual route is what actually enforces it). */
export function permissionsForRole(role: ClientRole): readonly ClientPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

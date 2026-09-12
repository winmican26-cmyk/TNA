/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Explicit, closed operator role model.
 * These roles are a CLI-local, additive guardrail layered on top of each accepted subsystem's own real
 * server-side authorization (Gate's admin/approver/agent split, Platform's platform-admin/-operator/
 * -service/-agent split, the client gateway's admin-token/service-identity split) — this file never
 * grants authority a subsystem itself would refuse; it only lets the CLI refuse locally, before ever
 * making a network call, and with a clearer operator-facing error than a bare 403 would give (section 8:
 * "Do not invent implicit superuser authority").
 */

export const OPERATOR_ROLES = ['viewer', 'operator', 'security-operator', 'admin'] as const;
export type OperatorRole = typeof OPERATOR_ROLES[number];

const RANK: Readonly<Record<OperatorRole, number>> = { viewer: 0, operator: 1, 'security-operator': 2, admin: 3 };

export function roleAtLeast(role: OperatorRole, minimum: OperatorRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export function isOperatorRole(value: unknown): value is OperatorRole {
  return typeof value === 'string' && (OPERATOR_ROLES as readonly string[]).includes(value);
}

/** Section 9: high-risk operator actions requiring a stronger role. Section 8: every other consequential
 * command requires at least 'operator' — 'viewer' is read-only, full stop. */
export const COMMAND_MIN_ROLE: Readonly<Record<string, OperatorRole>> = {
  'status': 'viewer', 'health': 'viewer', 'doctor': 'viewer',
  'tenant list': 'viewer', 'tenant show': 'viewer',
  'tenant create': 'operator', 'tenant activate': 'operator', 'tenant suspend': 'operator',
  'tenant offboard': 'admin',
  // Note: "tenant reactivate" (resuming a SUSPENDED tenant back to ACTIVE) is intentionally NOT wired —
  // `ClientStore.resumeTenant` exists and is tested at the library level, but no HTTP route for it was
  // ever exposed by the accepted Volume 10 client gateway, and Volume 11 does not redesign Client
  // Integration to add one. See the Volume 11 proof-of-work's "Remaining Limitations."
  'service list': 'viewer', 'service create': 'operator', 'service rotate': 'operator',
  'service revoke': 'security-operator',
  'mcp list': 'viewer', 'mcp register': 'operator', 'mcp discover': 'operator', 'mcp inspect': 'viewer',
  'tool list': 'viewer', 'tool inspect': 'viewer',
  'tool enable': 'operator', 'tool enable-critical': 'security-operator', 'tool disable': 'operator',
  'action list': 'viewer', 'action show': 'viewer', 'action evidence': 'viewer', 'action reconstruct': 'viewer', 'action explain': 'viewer',
  'hold list': 'viewer', 'hold inspect': 'viewer', 'hold approve': 'operator', 'hold reject': 'security-operator',
  'incident status': 'viewer', 'incident collect': 'operator',
  'audit run': 'operator', 'audit show': 'viewer',
  'deployment status': 'viewer',
  'go-live assess': 'operator', 'handoff generate': 'admin',
  // Section 34: Academy commands are training-only and never touch production authority (TNA-69) — the
  // lowest role, 'viewer', is sufficient for every one of them, deliberately.
  'academy status': 'viewer', 'academy lesson': 'viewer', 'academy lab start': 'viewer',
  'academy lab verify': 'viewer', 'academy assessment': 'viewer',
};

/** Matches the longest known command key against the leading words of `positionals` — e.g. `['tenant',
 * 'show', 'ten_abc']` resolves to `'tenant show'` (a known two-word command), never the useless
 * three-word join `'tenant show ten_abc'`. Longer commands are tried before shorter ones so `'academy
 * lab verify'` is not mistaken for the (nonexistent) bare command `'academy'`, and `'tenant list'` is
 * not mistaken for `'tenant'`. */
export function resolveCommandKey(positionals: readonly string[]): string | null {
  const threeWord = positionals.slice(0, 3).join(' ');
  if (positionals.length >= 3 && COMMAND_MIN_ROLE[threeWord]) return threeWord;
  const twoWord = positionals.slice(0, 2).join(' ');
  if (positionals.length >= 2 && COMMAND_MIN_ROLE[twoWord]) return twoWord;
  const oneWord = positionals[0];
  if (oneWord && COMMAND_MIN_ROLE[oneWord]) return oneWord;
  return null;
}

export class OperatorAuthError extends Error {
  public constructor(message: string) { super(message); this.name = 'OperatorAuthError'; }
}

/** Throws if `role` cannot run `commandKey` (e.g. `'tenant offboard'`). Called before any HTTP request
 * is issued for a command — a locally-refused command never reaches a subsystem at all. */
export function assertRoleAllows(commandKey: string, role: OperatorRole): void {
  const minimum = COMMAND_MIN_ROLE[commandKey];
  if (!minimum) throw new OperatorAuthError(`Unknown command: ${commandKey}`);
  if (!roleAtLeast(role, minimum)) {
    throw new OperatorAuthError(`Command "${commandKey}" requires role "${minimum}" or higher — current profile role is "${role}"`);
  }
}

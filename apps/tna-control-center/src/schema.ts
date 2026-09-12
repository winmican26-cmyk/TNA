/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Domain types for the Control Center's own
 * BFF (backend-for-frontend) layer. This package holds NO authority of its own — it is a thin, session
 * -authenticated proxy in front of already-accepted backend services (`apps/tna-platform` in this first
 * increment). See docs/control-center/frontend-security-boundary-v0.1.md (pending) for the full boundary
 * statement; the short version is section 3 of the kickoff brief: BROWSER -> authenticated TNA API ->
 * existing accepted backend service -> Gate/Sentinel/... -> Ledger evidence. Never the reverse.
 */

export const CLIENT_ROLES = ['client-viewer', 'client-reviewer', 'client-admin', 'client-auditor'] as const;
export type ClientRole = typeof CLIENT_ROLES[number];

export interface ControlCenterUser {
  readonly user_id: string;
  readonly tenant_id: string;
  readonly username: string;
  readonly role: ClientRole;
  readonly created_at: string;
  readonly disabled: boolean;
}

export interface ControlCenterSession {
  readonly session_id: string;
  readonly user_id: string;
  readonly tenant_id: string;
  readonly role: ClientRole;
  readonly csrf_token: string;
  readonly created_at: string;
  readonly expires_at: string;
}

/** Section 64/65: a tenant's registered backend — each real TNA deployment is one tenant's own Platform
 * instance (mirrors the existing single-tenant-per-process convention already established by
 * `apps/tna-platform`/`apps/tna-client-gateway`/`apps/tna-improvement-governor`). The Control Center never
 * accepts a tenant identifier from a request — it always resolves the CALLER's own tenant's registry entry
 * from their authenticated session, so a request naming a different tenant's resource has no code path to
 * reach that tenant's actual backend at all. */
export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type TenantStatus = typeof TENANT_STATUSES[number];

export interface TenantRegistryEntry {
  readonly tenant_id: string;
  /** Section 25/foundation-review: a Control-Center-LOCAL suspension flag — fail-closed for both new
   * logins and every active-authority route once set. Defaults to `ACTIVE` when omitted. Honest scope
   * note: this is NOT yet wired to Volume 10's real `ClientStore` tenant lifecycle
   * (PENDING/ACTIVE/SUSPENDED/OFFBOARDING/OFFBOARDED) — that cross-volume integration remains a
   * documented follow-up, not silently claimed as covered. */
  readonly status?: TenantStatus;
  readonly platform_base_url: string;
  /** An AGENT-scoped token — sufficient for read-only routes (list/get/evidence). Never sufficient for
   * `/approve` or `/terminate`, which Platform itself restricts to `platform-operator`/`platform-admin`
   * roles regardless of what this BFF asks for (section 16: enforced at the trusted backend boundary, not
   * merely by this proxy choosing not to expose a button). */
  readonly platform_token: string;
  /** An OPERATOR-scoped token — required for `/approve` and `/terminate`. Held server-side only; the
   * browser never sees either token. */
  readonly platform_operator_token: string;
  /** Optional — Ledger and Auditor are, like Platform, single-tenant-per-process real services
   * (`createLedgerServer`/`createAuditorServer` both take a fixed `tenantId` at construction). `null`/
   * absent means the Evidence Explorer / Audit page routes fail closed (503) for this tenant rather than
   * silently falling back to a weaker or fabricated view. */
  readonly ledger_base_url?: string;
  readonly ledger_reader_token?: string;
  /** Ledger's own `verifyAll()` requires an ADMIN-scoped principal (`assertIsAdmin`) — the reader token
   * alone is insufficient for whole-ledger integrity verification, only for search/stream/event reads. */
  readonly ledger_admin_token?: string;
  readonly auditor_base_url?: string;
  readonly auditor_token?: string;
  /** Optional — the Recursive Improvement Governor (Volume 12) is, like Platform/Ledger/Auditor, a real
   * single-tenant-per-process service (`createImprovementGovernorServer` takes a fixed `tenantId` at
   * construction) that holds one shared admin-scoped token per tenant (its own HTTP layer has no separate
   * reader/operator token split — every route past `/live`/`/ready` requires this one bearer token). `null`
   * /absent means the recursive-improvement lineage UI fails closed (503) for this tenant, never a
   * fabricated or empty lineage. */
  readonly improvement_base_url?: string;
  readonly improvement_admin_token?: string;
}

export class ControlCenterError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ControlCenterError';
  }
}

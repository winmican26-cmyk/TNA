# TNA Client Control Center v0.1 — Foundation Review

This is a security baseline for CONTINUING Volume 13 development — not the final threat model, and not an
acceptance document. It exists because session security, tenant resolution, and role boundaries underpin
every later page (evidence explorer, tools UI, incidents, onboarding, recursive-improvement UI); if any of
these three foundations were wrong, everything built on top would inherit the flaw.

## 1. Session architecture

Full path audited: login → password verification → session creation → session cookie issuance → CSRF
binding → authenticated read → authenticated mutation → logout → session invalidation → expiry.

| Property | Status | How it's true |
|---|---|---|
| Session IDs are cryptographically random | PASS | `randomBytes(32).toString('hex')` (`session-store.ts`), never derived from any input |
| Login cannot preserve an attacker-controlled prior session ID | PASS | `createSession()` takes no session-id parameter at all — there is no code path from a request's `Cookie` header into the newly-minted session id. Tested: `session-lifecycle.test.ts` "session fixation" |
| Successful login rotates/replaces any previous session | DOCUMENTED, NOT ENFORCED (deliberate) | See "Multi-session semantics" below — a new login does not invalidate other sessions. This is a considered product decision, not an oversight |
| Logout invalidates the session server-side | PASS | `destroySession()` deletes the real SQLite row | 
| Logout cookie clearing alone is not sufficient | PASS | Server-side deletion happens independently of what cookie header the client sends back; a replayed pre-logout cookie fails because the row is gone, not because the browser "forgot" a cookie |
| Expired sessions cannot be revived | PASS | `getSession()` checks `expires_at` against the store's own clock and deletes-and-returns-null on expiry; no "grace" path |
| Unknown session IDs fail closed | PASS | `SELECT ... WHERE session_id=?` finds no row → 401 |
| Forged session IDs fail closed | PASS | Same mechanism — a well-formed-but-never-issued id has no row |
| Deleted sessions fail closed | PASS | Same mechanism |
| CSRF token is bound to its exact authenticated session | PASS | `csrf_token` is a column on the session row itself, compared via `timingSafeEqual` against the session resolved from the REQUEST'S OWN cookie — never a bare, session-independent secret |
| CSRF token belonging to Session A fails with Session B | PASS | Tested explicitly: `session-lifecycle.test.ts` "cross-session CSRF" |
| CSRF token cannot establish authentication | PASS | Tested: CSRF header with no session cookie → 401 |
| Session expiry is enforced by the server | PASS | Real, deterministic-clock test in `session-lifecycle.test.ts` — valid at 7h59m, invalid at 8h01m against an 8h TTL |

### Multi-session semantics (documented, not a gap)

A user may hold multiple concurrent, independent sessions (e.g. two browsers/devices). **A new login does
NOT invalidate the user's other existing sessions.** Each session is independently random, independently
expiring, and independently revocable (`destroySession` takes one specific session id, never "all sessions
for this user"). This is a deliberate decision for a multi-device enterprise client console — not every
system needs single-session-per-user semantics, and forcing it here would be a worse UX for no
security benefit given every session already carries its own independent, strongly random, bounded
-lifetime credential. Tested explicitly (not merely asserted) in `session-lifecycle.test.ts`.

If a future requirement demands single-session-per-user (e.g. a "log out all other sessions" security
feature), the schema already supports it cleanly: `destroySession` generalizes trivially to
`destroyAllSessionsForUser(userId)`. Not built in this pass because nothing in the kickoff brief required
it, and building unrequested mechanism is explicitly out of this project's discipline.

## 2. Cookie policy

| Cookie | HttpOnly | Secure | SameSite | Path | Domain | Max-Age |
|---|---|---|---|---|---|---|
| Session (`tna_cc_session`) | **true**, always | `true` in production (`TNA_CONTROL_CENTER_COOKIE_SECURE=true`), `false` in local dev only | `Lax` | `/` | unset (host-only — never a broad parent domain) | 8 hours, matches the server-side TTL exactly |
| CSRF (`tna_cc_csrf`) | **false** (must be JS-readable for the double-submit pattern) | Same production/dev rule as the session cookie | `Lax` | `/` | unset | 8 hours |

Production security is never silently downgraded for development convenience: the `Secure` flag is
controlled by one explicit environment variable (`TNA_CONTROL_CENTER_COOKIE_SECURE`), defaulting to
**off** only because local HTTP development has no TLS to be `Secure` about — a real production deployment
must set this variable explicitly, and nothing in the code path infers "production" automatically and
silently. This is the one honest gap in this section: there is currently no automatic fail-closed check
that REFUSES to start if `NODE_ENV=production`-equivalent and `cookieSecure` is still false. Recommended
follow-up, not yet built (see Known Limitations).

## 3-7. Adversarial session tests

All of the following are real, passing, HTTP-level tests in `tests/control-center/session-lifecycle.test.ts`
(no unit-level shortcut on the functions in isolation):

- Session fixation (attacker plants a pre-login cookie; the issued session id never equals it; the planted
  id never authenticates anything).
- Session-id randomness (two logins for the same user produce unrelated, 64-hex-char, non-colliding ids).
- Documented multi-session behavior (a second login does not invalidate the first).
- Logout replay (a captured, pre-logout cookie fails after logout — real row deletion, not cookie hygiene).
- Deterministic expiry (`TestClock` — valid at T+7h59m, invalid at T+8h01m against the real server-side TTL).
- Forged / unknown / deleted session ids (three distinct scenarios, all 401).
- Cross-session CSRF (Session A + Session B's CSRF token fails; Session B + Session A's CSRF token fails;
  each session's own real token still works, proving the failures are real binding checks).
- CSRF token alone, no session cookie, cannot authenticate.

## 8-12. Tenant-registry architecture

Every real TNA deployment is one tenant's own `apps/tna-platform` instance (the same single-tenant
-per-process convention already established by every prior accepted backend app in this project). The
Control Center is the first app that talks to MORE THAN ONE tenant's backend from a single process, so its
`TenantRegistry` is a genuine routing security boundary, treated as such:

- **Tenant derivation**: `tenantEntry(deps, session)` resolves EXCLUSIVELY from `session.tenant_id` — the
  authenticated session's own column, set once at session-creation time from the authenticated user's own
  `tenant_id`. No route reads a tenant identifier from a query parameter, JSON body field, path segment,
  or custom header — because no route's handler code contains any such read at all. This is a structural
  guarantee, not a runtime check: there is nothing to bypass because there is no alternate code path.
- **Adversarial proof**: `tests/control-center/tenant-boundary.test.ts` explicitly attempts `?tenantId=`,
  `?tenant=`, `?tenant_id=` query overrides; JSON body `tenant_id`/`tenantId` fields on a mutating route;
  and custom `X-Tenant-Id`/`X-Tenant` headers. All are proven to have zero effect — the response always
  reflects only the authenticated session's own tenant.
- **Normalization / case sensitivity**: tenant ids are opaque, case-SENSITIVE byte strings — no
  normalization (case-folding, trimming, Unicode normalization) is applied anywhere. `"Tenant-X"` and
  `"tenant-x"` are proven to resolve to two distinct, non-colliding registry entries and distinct real
  backends (`tenant-boundary.test.ts`).
- **Duplicate registration**: a registry containing the same `tenant_id` twice is REJECTED at load time
  (`ControlCenterError`) — both `loadTenantRegistry` (JSON file) and `tenantRegistryFromEntries`
  (programmatic/test construction) throw rather than silently last-write-wins. This closes a real
  misconfiguration risk: a duplicate entry could otherwise silently redirect an existing tenant's traffic
  to the wrong backend depending on array order.
- **Unknown tenant**: fails closed with `503` ("no registered backend") — never a default/fallback backend.
- **Suspended tenant**: fails closed for BOTH new logins (403 before a session is ever minted) AND every
  active-authority route for an existing session (`tenantEntry()`'s own check, defense in depth). **Update
  (resolved during the five-surface checkpoint, see section 25)**: when a Client Gateway is configured, the
  DATA SOURCE for this check is now Volume 10's real `ClientStore` lifecycle record
  (`PENDING`/`ACTIVE`/`SUSPENDED`/`OFFBOARDING`/`OFFBOARDED`), queried live via the real admin API — never
  a Control-Center-local flag drifting independently of it. The local `status` field on a registry entry
  remains a fallback only when no Client Gateway is configured for the deployment at all.
- **Tenant platform creation/reuse/removal**: out of scope for this review — the registry in v0.1 is a
  static, operator-provisioned JSON file (or programmatic construction in tests); there is no runtime
  "provision a new tenant" flow yet. This is an honest, not-yet-built feature, not a hidden defect.
- **Concurrent tenant access**: proven safe under real concurrent HTTP load in `concurrency.test.ts` — two
  tenants' sessions served by the same Control Center process simultaneously never cross-contaminate.

## 11-12. Cross-tenant object access and existence leakage

Extended beyond the original single cross-tenant-read proof. All real, separate Platform instances — never
a mocked repository (`tests/control-center/cross-tenant-objects.test.ts`):

- Cross-tenant **read**: 404 (pre-existing).
- Cross-tenant **approve**: 404.
- Cross-tenant **terminate**: 404.
- Cross-tenant **pagination**: Tenant B's actions never appear in Tenant A's listing; a foreign-tenant
  -shaped cursor value is rejected by Platform's own real cursor validation (400), never resolved as if
  valid.
- Cross-tenant **filtering/search**: **N/A** — Platform's real `GET /v1/platform/actions` route supports
  only `limit`/`cursor` (`readPageParams` rejects any other query parameter with 400); there is no
  filter/search capability to probe for leakage through. Not silently skipped — verified absent.
- **Object-existence leakage**: explicitly tested and proven structurally impossible, not merely handled
  by a careful status-code choice. Because each tenant's Platform instance is a wholly separate real
  process/store, a cross-tenant object ID and a genuinely nonexistent object ID produce the IDENTICAL
  response (404, same error shape) — there is no code path where the Control Center could distinguish
  "exists in another tenant" from "does not exist at all," because the only backend a given session can
  ever reach genuinely has no row for either case.

## 13-17. Client role model

The single authoritative permission matrix now lives in `apps/tna-control-center/src/permissions.ts`
(`CLIENT_PERMISSIONS`, `ROLE_PERMISSIONS`, `authorizeClientPermission()`). Every route handler calls
`requirePermission(session, permission)` — never an inline `if (role === '...')`. The invariant:

```
ROLE -> PERMISSIONS -> SERVER-SIDE AUTHORIZATION      (what this codebase now does)
ROLE -> UI BUTTON VISIBILITY                          (never, by itself, the security control)
```

| Permission | viewer | auditor | reviewer | admin |
|---|---|---|---|---|
| `action.read` | ✓ | ✓ | ✓ | ✓ |
| `action.approve` / `.reject` / `.terminate` | | | ✓ | ✓ |
| `evidence.read` | ✓ | ✓ | ✓ | ✓ |
| `audit.read` | ✓ | ✓ | ✓ | ✓ |
| `incident.read` | ✓ | ✓ | ✓ | ✓ |
| `incident.acknowledge` | | ✓ | | ✓ |
| `tool.read` / `connection.read` / `identity.read` / `improvement.read` / `organization.read` | ✓ | ✓ | ✓ | ✓ |
| `tool.enable.request` / `.disable.request` | | | | ✓ |
| `identity.create` / `.suspend` / `credential.rotate` | | | | ✓ |
| `improvement.approve` / `.promote` / `.rollback` | | | | ✓ |
| `organization.manage` | | | | ✓ |

**No role, including `client-admin`, is ever granted a TNA-operator-only capability.** There is no
permission in this matrix — at any role — that maps to an operator-only Platform/Gate/Sentinel/Ledger/
Improvement-Governor route. Verified structurally: the matrix's own closed `CLIENT_PERMISSIONS` enum
contains no such permission to accidentally grant (`role-matrix.test.ts`, "permission matrix" test).

Most permissions above (`evidence.*`, `audit.*`, `incident.*`, `tool.*` beyond read, `connection.*`,
`identity.*`, `credential.*`, `improvement.*`, `organization.manage`) have **no HTTP route wired to them
yet** in this increment — they exist in the matrix now so every future route has an unambiguous,
already-reviewed answer to consult, rather than each future page inventing its own check.

### Role boundary tests (real HTTP, `role-matrix.test.ts`)

- viewer: read PASS, approve/terminate DENY (403).
- reviewer: read PASS, eligible approval PASS.
- auditor: action/evidence read PASS, terminate DENY (403).
- admin: permitted mutation (approve) PASS.
- Request-body role/permission escalation (`{role: 'client-admin', permissions: ['*'], isAdmin: true}`
  smuggled into a viewer's terminate request): **no effect** — still 403.

## 18-19. BFF trust boundary

The BFF is, and remains: an authentication boundary, a tenant-resolution boundary, a client-role boundary,
a presentation-aggregation layer, and a proxy into accepted TNA APIs. It is explicitly **not** a
reimplementation of Gate, Sentinel, Auditor, Ledger, or the Improvement Governor.

For the two currently-proxied mutating operations:

```
Browser -> POST /api/actions/:id/approve (session cookie + CSRF header)
        -> tenant derived from session.tenant_id (never the request)
        -> requirePermission(session.role, 'action.approve')   [BFF may DENY here]
        -> real Platform POST /v1/platform/actions/:id/approve, using the tenant's real OPERATOR token
        -> real PlatformControlOrchestrator.resume() — real role check, real state-machine check
        -> BFF returns Platform's own real response verbatim
```

**Proven** (`role-matrix.test.ts`, "BFF trust boundary"): a `client-reviewer` session — which the BFF's own
permission check happily allows — attempts to approve a real action that is NOT currently `HELD` (already
`COMPLETED`). The real Platform backend refuses with `INVALID_TRANSITION`, and the BFF surfaces that real
rejection; it does **not** fabricate a success merely because the caller's client role was otherwise
eligible. The BFF may narrow what a role is allowed to attempt; it can never widen what the real backend
would actually permit.

## 20. Evidence authority

Search performed across `apps/tna-control-center/src/*.ts` for hardcoded/invented status assignment
(`ALLOW`, `BLOCK`, `PASS`, `VERIFIED`, `HEALTHY`, `COMPLETED`, etc.): the only such literals found are
(a) the frontend's `styles.css`/component CSS-class names (`status-AVAILABLE`, `status-BLOCKED`, ...) —
static presentation labels, not truth assignments; (b) the dashboard's own defensive
`.catch(() => ({status: 'UNAVAILABLE' as const, ...}))` fallback when the real backend call itself
fails/throws — this is the CORRECT, honest behavior (an unreachable backend is reported as `UNAVAILABLE`,
never silently defaulted to a healthy status; tested in `dashboard-actions.test.ts`). No file assigns a
current-state truth value to a variable independent of a real backend response.

## 21-24. Credential storage, error redaction, logging

- **Browser storage**: `secret-audit.test.ts` proves, by scanning actual source files (not by inspection
  claim), that no frontend `.ts`/`.tsx` file uses `localStorage` or `sessionStorage` in real code (a
  doc-comment mentioning them by name to document their absence does not count, and the test explicitly
  strips comments before scanning to avoid that exact false positive). Session identity lives ONLY in the
  HttpOnly cookie, which frontend JS structurally cannot read.
- **CSRF token exposure**: the session cookie's name never appears anywhere in frontend source at all —
  proven by an explicit string-absence check, not merely "we didn't call `document.cookie` on it."
- **Console logging**: no frontend or BFF source file logs a password/token/secret/session-id/csrf-token
  -shaped value via `console.log`/`error`/`warn`/`debug` (regex-scanned, real files).
- **Backend token leakage**: no BFF route handler's `send()` call (the only browser-facing response
  surface) ever includes a tenant-registry token field.
- **Built bundle**: the actual `vite build` output contains no reference to the tenant-registry file path
  or the `platform_operator_token` field name.
- **Error redaction**: `security.test.ts`'s pre-existing test triggers a real backend-unreachable failure
  and confirms the resulting error body contains no SQLite path, no filesystem path, and no bearer token.

## 25. Suspended/offboarded tenant

Covered under section 8-12 above. **Resolved** (closure item A, addressed during the five-surface
checkpoint pass): `apps/tna-control-center/src/server.ts`'s `checkTenantLifecycle()` now queries the real,
accepted Volume 10 `ClientStore` record (via the real Client Gateway admin API's `GET
/v1/admin/tenants/:id`) on every login and on every tenant-scoped request, and treats ITS status
(`PENDING`/`ACTIVE`/`SUSPENDED`/`OFFBOARDING`/`OFFBOARDED`) as authoritative whenever a Client Gateway is
configured for the deployment — the Control-Center-local `TenantRegistryEntry.status` flag is not
consulted at all in that case, so the Control Center can no longer believe a tenant is ACTIVE while Volume
10 believes it is SUSPENDED (or vice versa). Proven in
`tests/control-center/client-gateway-integration.test.ts` (tenant lifecycle reconciliation via a real
`ClientStore` suspension) and `tests/control-center/tenant-registry.test.ts` (suspended-tenant fail-closed
behavior). The local flag remains a fallback ONLY for a Platform-only tenant entry with no configured
Client Gateway (an intentionally narrower, still-real "ONE lifecycle truth for what this deployment
actually has" — never a second, independently-drifting truth layered on top of a configured Client
Gateway).

## 26. Concurrency

Real concurrent HTTP requests (`tests/control-center/concurrency.test.ts`):

- Two simultaneous reads on the same session — both succeed, consistent data.
- Two independent sessions for the same tenant — one logging out never affects the other.
- Two different tenants served by the same process under concurrent load — no cross-contamination across
  10 interleaved requests per tenant.
- Logout racing a mutation — the mutation resolves to a real, non-corrupted outcome (200/401/403 all
  acceptable), and the session is unambiguously gone afterward regardless of race order.
- Expiry racing a mutation — once the deterministic clock has passed the TTL, the mutation is rejected.

## 27. Foundation security headers

Unchanged and still tested (`security.test.ts`): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and a baseline `Content-Security-Policy` (`default-src 'self'; frame
-ancestors 'none'`). A more complete CSP (script/style/connect-src allowlisting) and CORS pass remains
later Volume 13 work, per the kickoff brief's own sequencing (section 27: "can still happen later").

## Known limitations (honest, not hidden)

- Cookie `Secure` flag has no automatic production fail-closed check — it is operator-set via
  `TNA_CONTROL_CENTER_COOKIE_SECURE`, not auto-detected.
- Tenant suspension is now reconciled against Volume 10's real `ClientStore` lifecycle whenever a Client
  Gateway is configured (see section 25, resolved) — the local flag is a fallback only for Platform-only
  configurations with no Client Gateway at all, never a second source of truth alongside a configured one.
- No "log out all other sessions" capability (multi-session is the deliberate default; a revocation
  feature is a plausible, not-yet-requested future addition).
- No tenant provisioning/removal runtime flow — the registry is static, operator-provisioned configuration.
- Full CSP (beyond the baseline `default-src`/`frame-ancestors`) and CORS configuration remain later work.
- Most of the permission matrix (`evidence.*`, `audit.*`, `incident.*`, `tool.*`, `connection.*`,
  `identity.*`, `credential.*`, `improvement.*`, `organization.manage`) has no HTTP route wired to it yet —
  the matrix is settled now so future routes have an unambiguous answer, not because those pages exist.

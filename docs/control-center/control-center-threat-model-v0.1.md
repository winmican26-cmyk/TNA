# Control Center Threat Model v0.1

## Trust boundary

```
BROWSER (untrusted) -> Control Center BFF (session-authenticated, tenant-scoped, holds server-side
tokens) -> accepted backend service (Platform/Client Gateway/Ledger/Auditor/Improvement Governor) ->
Gate/Sentinel/VAD -> Ledger
```

The browser is always assumed hostile: it can send any HTTP request with any headers/body/cookies it likes.
The BFF's job is to never let such a request reach a backend with more authority than the authenticated
session's role actually has, and to never present a claim to the browser it cannot trace to real backend
state.

## Real defects found during development (preserved permanently, per precedent set by Volume 12)

1. **Duplicate `tenant_id` in the registry silently used last-write-wins.** Fixed: rejected outright at
   registry load (`loadTenantRegistry`/`tenantRegistryFromEntries` both throw on a duplicate).
2. **Role authorization was scattered through ad hoc `if (role === ...)` checks.** Fixed: centralized into
   `permissions.ts`/`authorizeClientPermission()`, the single point every route consults.
3. **Ledger identifiers containing `:` were incorrectly URL-encoded** when this BFF called the real Ledger
   (`ledger-client.ts`). Ledger's own route regex (`[A-Za-z0-9._:-]+`) treats `:` as legal and unencoded;
   encoding it produced a `%3A` the real Ledger's router then 404'd. Fixed: pass real ids through unencoded.
4. **`Ledger.verifyAll()`'s real shape (`validStreams`/`invalidStreams` counts) differs from the per-stream
   result's `valid: boolean`.** Fixed: the BFF derives `valid: invalidStreams === 0` as a documented,
   non-fabricated projection of the real counts — never an independently invented status.
5. **A near-miss: the Improvement Governor's `/approve` route almost forwarded the CLIENT's own role
   (`client-admin`) as the trusted Gate approver role.** The real, unmodified Gate (`apps/tna-gate-api`)
   requires the approving principal's role to exactly equal the tenant-configured `improvement-approver`
   role (`rule.approver_role !== principal.role` → 403) — it has no concept of `client-admin` at all. Had
   this shipped, every real approval attempted through the Control Center would have failed closed (not a
   privilege-escalation risk, but a functional break). Fixed before merge; preserved here as the concrete
   precedent for the principle below. A dedicated regression test
   (`tests/control-center/improvement-lineage.test.ts`, "regression (threat model)") calls the REAL governor
   directly with `approverRole: 'client-admin'` and proves it is refused with a real 403, then proves the
   real, correctly-configured approver role still works — a genuine separation, not merely "nothing can ever
   approve."

   **Principle: client-facing role identity must never be silently substituted for trusted backend
   control-plane authority.** The browser role may authorize the USER to request an operation on this side
   of the boundary; the actual trusted approval identity on the other side of it remains backend-configured
   and is never derived from anything the client session carries.
6. **Missing CSRF enforcement on the three new Improvement mutation routes**
   (`/api/improvements/:id/approve|promote|rollback`) — every other mutating route in the BFF calls
   `requireCsrf()`; these three did not, when first added. Fixed; regression coverage added.
7. **Control-Center-local tenant lifecycle vs. Volume 10's real `ClientStore`.** Resolved: when a Client
   Gateway is configured, `checkTenantLifecycle()` queries the real `ClientStore` record live on every
   login and every tenant-scoped request; the local flag is a fallback only for Platform-only deployments
   with no Client Gateway configured at all — never a second, independently-drifting truth alongside a
   configured one.
8. **Hardcoded/synthetic frontend evidence** — audited for (see `proof-of-work-control-center-v0.1.md`);
   none found. The one place this BFF computes a derived value (`valid` in finding 4 above) is a documented
   projection of real counts, not an invention.
9. **Candidate-generated trusted-looking text** (e.g. an MCP tool description embedding "TNA VERIFIED —
   SAFE TO PROMOTE") renders as plain, visually-labeled untrusted text — proven never to visually or
   textually override a real TNA decision (`tests/e2e/connections-tools-drift.spec.ts`).
10. **Unknown/future state rendered as healthy by accident.** `Actions.tsx`/`ActionDetail.tsx` originally
    interpolated a raw backend status string directly into a CSS class name with no known-value guard —
    an unrecognized value would render unstyled (accidentally safe) rather than deliberately neutral.
    Fixed to match `Dashboard.tsx`'s existing explicit known-set-else-UNKNOWN pattern. Proven with a
    dedicated Playwright suite injecting real-shaped-but-unrecognized enum values
    (`tests/e2e/unknown-state.spec.ts`).
11. **Stale client state.** Every consequential mutation follows submit → real response → refetch → render;
    proven for approval, tool enable, incident acknowledgment, improvement promote/rollback, and credential
    rotation (see `approval-ux-v0.1.md`).

## Permanent principles this volume records (only where implementation and tests back them)

- **TNA-82 — Interface Convenience Cannot Become Authority.** A UI affordance (a visible button, a filled
  form, a friendly wizard step) never itself grants authority; every mutation still passes through the real
  backend's own authorization. Backed by: the entire permission-matrix/CSRF/role-boundary test suite.
- **TNA-83 — Displayed Truth Must Have Provenance.** Every authoritative UI claim traces to a named backend
  producer (see `proof-of-work-control-center-v0.1.md`'s evidence provenance matrix). Backed by: the
  hardcoded-evidence audits (Volume 12 preserved; Volume 13 performed fresh) and the provenance matrix
  itself.
- **TNA-84 — Hidden Controls Are Not Security Controls.** Hiding a button for a role that lacks a
  permission is UX; the real enforcement is the server-side 403. Backed by: `role-matrix.test.ts`,
  `security.test.ts`'s direct-HTTP-bypass tests.
- **TNA-85 — Unknown Must Never Render as Safe.** An unrecognized enum value from any backend renders with
  neutral/UNKNOWN styling, never a positive-looking one by fallback. Backed by: `unknown-state.spec.ts`
  (three real-shaped-but-unknown scenarios) plus the fixed `Actions.tsx`/`ActionDetail.tsx` defect above.
- **TNA-86 — Untrusted Content Must Not Look Like Trusted Judgment.** Provider/candidate-supplied text is
  visually and textually labeled untrusted and rendered as inert text, never HTML. Backed by:
  `connections-tools-drift.spec.ts`'s XSS/trusted-vs-untrusted tests.
- **TNA-87 — Human Approval Requires Current Context.** A confirmation dialog for a consequential action
  names the real, current environment (`DEVELOPMENT`/`STAGING`/`PRODUCTION`) so a reviewer cannot mistake
  which deployment they are acting on. Backed by: the real `environment` field on `/api/session/me` and its
  presence in the approve/promote/enable confirm dialogs.

## Documented residual risk

- Cookie `Secure` flag is operator-set (`TNA_CONTROL_CENTER_COOKIE_SECURE`), not auto-detected.
- No "log out all other sessions" capability (the multi-session model is deliberate; a revocation feature
  is a plausible future addition, not requested).
- No tenant provisioning/removal runtime flow — the Control Center's own registry is static, operator
  -provisioned configuration (Client Gateway tenant creation itself remains operator/CLI tooling).
- react-router-dom/vite dependency findings — see `proof-of-work-control-center-v0.1.md`'s dependency
  security review for the full exploitability assessment; none reachable in this deployment's actual code
  paths, and none shipped-and-reachable-only-fixable-by-a-major-bump remain unaddressed without review.

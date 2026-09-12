# Control Center Requirement Matrix v0.1

| Requirement | Status | Evidence |
|---|---|---|
| BROWSER → BFF → accepted backend → Gate/Sentinel → Ledger, never BROWSER → "UI says safe" | Met | Every route in `server.ts` proxies a real backend call; `secret-audit.test.ts` |
| Session security (fixation/rotation/replay/expiry) | Met | `session-lifecycle.test.ts`, `session.test.ts` |
| CSRF on every mutating route | Met | `security.test.ts`; fixed gap on improvement routes, regression added |
| Tenant resolution only from session | Met | `tenant-boundary.test.ts`, `tenant-isolation.test.ts` |
| Central permission matrix, never scattered role checks | Met | `permissions.ts`, `role-matrix.test.ts` |
| Connections / MCP visibility | Met | `client-gateway-integration.test.ts`, `connections-tools-drift.spec.ts` |
| Governed tools + real schema drift | Met | Same, plus real MCP fixture schema-v2 transition |
| Evidence Explorer + Ledger integrity | Met | `evidence-audit.test.ts`, `evidence-and-audit.spec.ts` |
| Audit / assurance + non-certification disclaimer | Met | Same |
| Incidents as live aggregation, not fabricated | Met | `incidents.ts`, `incidents.test.ts`, `incidents.spec.ts` |
| Recursive-improvement lineage UI, flagship | Met | `improvement-lineage.test.ts`, `improvements.spec.ts` |
| Competence/authority/capability/control-plane visually separate | Met | `ImprovementDetail.tsx` |
| Rejected-successor scenario is evidence-honest | Met | Demo Flow 7; no fabricated "benchmark improved" claim |
| Onboarding wizard, discovery ≠ authorization | Met | `Onboarding.tsx`; A/B/C capability classification documented |
| Identity/credential lifecycle mapped to Volume 10 | Met | `Identities.tsx`; no second source of truth |
| Credential never persists in browser storage | Met | `credential-leakage.spec.ts` |
| Notifications, polling only | Met | `notifications.ts` |
| Tenant lifecycle: Volume 10 authoritative | Met | `checkTenantLifecycle()`, foundation review section 25 (resolved) |
| Stale-state discipline (no optimistic mutation) | Met | `stale-state.spec.ts` + per-surface tests |
| Unknown-state never renders as safe | Met | `unknown-state.spec.ts`; TNA-85 |
| Candidate/provider text never impersonates a TNA decision | Met | `connections-tools-drift.spec.ts`; TNA-86 |
| Environment identity in high-risk confirmations | Met | Real `environment` field; TNA-87 |
| Production CORS (exact-match, no wildcard+credentials) | Met | `security.test.ts` CORS tests |
| Production CSP (no unsafe-inline/eval) | Met | `security.test.ts` CSP test |
| Clickjacking (`frame-ancestors`, `X-Frame-Options`) | Met | Same |
| Source-map policy decided and documented | Met | `vite.config.ts`, disabled |
| Container path (real build, real run, real login/dashboard) | Met | `control-center-verification-v0.1.md` |
| Dependency security review, no blind `--force` | Met | `proof-of-work-control-center-v0.1.md` |
| Full Playwright acceptance coverage, no interception on acceptance paths | Met | 25 real-browser tests |
| Hardcoded-authoritative-evidence audit (v13, and Volume 12 preserved) | Met | `proof-of-work-control-center-v0.1.md` |
| Evidence provenance matrix | Met | Same |
| Threat model with real findings preserved | Met | `control-center-threat-model-v0.1.md` |
| Demo flows 1-8, real backends, no seeded outcomes | Met | `demo-control-center-v01.ts` |
| Volume 12 hardcoded-evidence guarantee preserved | Met | Zero diff against `tna-recursive-improvement-v0.1` tag |

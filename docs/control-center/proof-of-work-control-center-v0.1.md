# Proof of Work — TNA Client Control Center & Assurance UI v0.1

## Development history (preserved in substance, not sanitized to a perfect final result)

```
1015 / 1015  Accepted Volume 12 baseline (tna-recursive-improvement-v0.1)
    |
    v
Initial Control Center BFF: real session-cookie auth, CSRF binding, tenant registry,
React/Vite client, Dashboard/Actions, packaged static frontend, real Platform-backed smoke
    |
    v
1032 / 1032
    |
    v
FOUNDATION REVIEW (32-item security checklist, mid-project checkpoint)
  -> session fixation/replay/expiry tests
  -> cross-session CSRF
  -> tenant override attacks (query/body/path/header)
  -> role matrix centralized

  real defect: duplicate tenant_id in registry silently used last-write-wins
    -> fixed by rejecting duplicate IDs at registry load
  real defect: role authorization scattered through ad hoc route checks
    -> centralized into permissions.ts / authorizeClientPermission()
    |
    v
1072 / 1072  FOUNDATION ACCEPTED FOR CONTINUED VOLUME 13 DEVELOPMENT
    |
    v
PRODUCT BACKEND SURFACES
  -> Connections / MCP, Governed Tools, schema drift
  -> Evidence Explorer, Audit / Assurance
  -> Improvement Governor integration (tenant lifecycle reconciled with Volume 10 ClientStore)

  real defect: Ledger stream/event IDs containing ":" were incorrectly URL-encoded
    -> fixed to match Ledger's own accepted route contract ([A-Za-z0-9._:-]+)
  real mismatch: Ledger verifyAll() exposes validStreams/invalidStreams, not a per-stream valid boolean
    -> BFF derives valid: invalidStreams === 0 as a documented, non-fabricated projection
  real defect (caught before merge): a client-facing role risked being forwarded as the trusted Gate
  improvement-approver role
    -> client permission and trusted backend approval authority explicitly separated;
       regression test calls the real governor directly to prove the substitution fails closed
    |
    v
1087 / 1087
    |
    v
CLIENT PRODUCT SURFACES
  -> Connections UI, Tools/schema-drift UI, Evidence Explorer UI, Audit UI
  -> recursive-improvement lineage UI (the flagship), Incidents
  -> Onboarding wizard, Identity/credential UX, Notifications
  -> first real-browser Playwright suite

  real defect: the new improvement approve/promote/rollback BFF routes lacked CSRF enforcement
    -> fixed; regression test added
    |
    v
1091 / 1091   Playwright 18 / 18
    |
    v
FINAL CLOSURE
  -> stale-state verification (submit -> real response -> refetch -> render, no optimistic mutation)
  -> unknown-state verification (a future/unrecognized enum never renders as healthy)
  -> production CORS (exact-match origin, no wildcard+credentials)
  -> production CSP (no unsafe-inline/unsafe-eval) and security headers on static responses too
  -> credential-persistence browser checks (localStorage/sessionStorage/IndexedDB/URL)
  -> real environment awareness (DEVELOPMENT/STAGING/PRODUCTION, never a frontend constant)
  -> 8 real demo flows, container verification, dependency security assessment
  -> full documentation set, evidence provenance matrix, Volume 13 hardcoded-evidence audit
    |
    v
1098 / 1098   Playwright 25 / 25   ARCHITECTURAL ACCEPTANCE
```

## Volume 12 preservation check

Performed before any Volume 13 closure work, per instruction: confirm the accepted Volume 12
(`tna-recursive-improvement-v0.1`, commit `d88ce81d337f595ff4a5a3a48711fc639386c525`) hardcoded-evidence
guarantee remains intact, and that Volume 13's new Recursive Improvement UI/BFF integration introduced no
regression.

- `git diff tna-recursive-improvement-v0.1 -- apps/tna-improvement-governor packages/improvement-core
  packages/improvement-schema packages/improvement-store packages/improvement-evaluator`: **empty**. Zero
  modification to any Volume 12 file.
- Direct inspection of the three NEW Volume 13 files that touch Recursive Improvement
  (`apps/tna-control-center/src/improvement-client.ts`, the improvement route block in `server.ts`,
  `apps/tna-control-center-web/src/pages/{Improvements,ImprovementDetail}.tsx`): every route passes the real
  governor's response straight through unmodified
  (`send(res, 200, await deps.improvement.X(entry, generationId))` — no field injection, no defaults, no
  wrapping). Every status string appearing in the frontend (`PROMOTED`/`REJECTED`/`ROLLED_BACK`/etc.)
  appears only in CSS-class-mapping tables or documentation comments, never as a fallback/default value.

**Result: Hardcoded authoritative evidence: NONE. Evidence provenance matrix: COMPLETE (Volume 12, unchanged
— see below for Volume 13's own). Fixture-only authoritative rows: NONE. No regression found.**

## Volume 13 hardcoded-authoritative-evidence audit

Grepped `apps/tna-control-center` and `apps/tna-control-center-web` production code (tests excluded) for:
`PASS`, `ALLOW`, `BLOCK`, `VERIFIED`, `HEALTHY`, `PROMOTED`, `REJECTED`, `ROLLED_BACK`, `INDETERMINATE`,
`ACTIVE`, `SUSPENDED`. 16 occurrences found; every one classified:

| File | Occurrence | Classification |
|---|---|---|
| `incidents.ts` | `a.state !== 'INDETERMINATE'` | Enum comparison against real fetched data |
| `schema.ts` | `TENANT_STATUSES` | Enum type definition (documented local-fallback-only) |
| `server.ts` (×3) | `status !== 'ACTIVE'`, `entry.status === 'SUSPENDED'`, `countByState(...)` | Enum comparison against real Client Gateway data; real aggregate over real fetched actions |
| `tenant-registry.ts` | config validator | Enum validation of operator-provided config, not evidence |
| `Actions.tsx`, `ActionDetail.tsx` | `KNOWN_ACTION_STATES` | CSS/display-mapping set (fixed this pass — see threat model finding 10) |
| `Evidence.tsx` (×4) | `IntegrityDisplay` type, `check.valid ? 'VERIFIED' : 'CORRUPT'` | Display label derived from a real boolean the real Ledger computed |
| `Identities.tsx` (×2), `Onboarding.tsx` (×2) | `status === 'ACTIVE'` comparisons/CSS mapping | Enum comparison / CSS mapping against real fetched data |

**Zero occurrences are a hardcoded/fabricated current-state claim independent of real backend evidence.**

## Evidence provenance matrix (Volume 13)

| UI claim | BFF route | Backend source | Authoritative producer |
|---|---|---|---|
| Action state (HELD/BLOCKED/COMPLETED/...) | `/api/actions`, `/api/actions/:id` | `apps/tna-platform` | Real Gate decision + Platform state machine |
| Action evidence | `/api/actions/:id/evidence` | `apps/tna-platform` | `reconstructPlatformAction` over real Ledger events |
| Dashboard assurance | `/api/dashboard` | `apps/tna-platform` `/ready` | `packages/deployment-health` real component probes |
| Connections/status | `/api/connections` | `apps/tna-client-gateway` | Real `McpServerRegistration.status` |
| Governed tool / schema drift | `/api/tools` | `apps/tna-client-gateway` | Real `GovernedToolDefinition.review_status`/`enabled` (`recordDiscovery`) |
| Ledger event / stream | `/api/evidence/search`, `/streams/:id` | `apps/tna-ledger` | Real `LedgerStore` rows |
| Ledger integrity (per-stream) | `/api/evidence/streams/:id/verify` | `apps/tna-ledger` | Real `verifyStream` hash-chain recomputation |
| Ledger integrity (whole-tenant) | `/api/evidence/verify` | `apps/tna-ledger` | Real `verifyAll` counts (`valid` is a documented derived projection, see evidence-visualization doc) |
| Audit assessment / results / findings | `/api/audit/assessments...` | `apps/tna-auditor` | Real `AuditorRuntime` evaluation over real evidence |
| Incident (any type) | `/api/incidents` | Aggregated: Platform readiness, Client Gateway, Ledger | `computeIncidents()` — a real, deterministic function over real, freshly-fetched signals; NOT a system of record |
| Incident acknowledgment | `/api/incidents/:sig/acknowledge` | Control Center's own SQLite | Real human action record, explicitly NOT a claim about the underlying condition |
| Improvement generation status | `/api/improvements`, `/api/improvements/:id` | `apps/tna-improvement-governor` | Real `ImprovementStore` row + real state machine |
| Improvement evaluation/authority/capability delta | `/api/improvements/:id/evidence` | `apps/tna-improvement-governor` | Real `reconstructImprovementGeneration` over real Ledger events (`runPromotionEvaluation`, `computeAuthorityDelta`, `computeCapabilityDelta`) |
| Improvement security-controls assessment | Same | `apps/tna-improvement-governor` | Real `assessImprovementGeneration` |
| Improvement lineage | `/api/improvements/:id/lineage` | `apps/tna-improvement-governor` | Real `reconstructImprovementLineage` over real Ledger streams only |
| Promotion / canary / rollback outcome | `/api/improvements/:id/{promote,rollback}` | `apps/tna-improvement-governor` | Real Gate-authorized state transition + real workspace-existence verification (rollback) |
| Service identity / credential | `/api/identities...` | `apps/tna-client-gateway` | Real `ClientServiceIdentity`/`IssuedCredential` |
| Tenant lifecycle | Every tenant-scoped route (`tenantEntry()`) | `apps/tna-client-gateway` | Real Volume 10 `ClientStore` record (authoritative whenever configured) |
| Organization / readiness | `/api/organization`, `/api/readiness` | `apps/tna-client-gateway` | Real `ClientTenant`, `assessOnboardingReadiness` |

**No authoritative row originates from a React state constant, a fixture, or a demo constant.**

## Dependency security review

`npm audit` on `apps/tna-control-center-web` (the only frontend with browser-shipped dependencies) before
this pass: 1 moderate, 4 high.

| Package | Version (before) | Severity | Path | Runtime-shipped? | Build-time only? | Exploitability here | Fixed version | Upgrade impact | Action | Residual |
|---|---|---|---|---|---|---|---|---|---|---|
| `react-router-dom` (+`react-router`, `@remix-run/router`) | 6.26.2 | High | Direct dependency | **Yes** — bundled into the shipped browser JS | No | Advisories are open-redirect/XSS-via-untrusted-redirect-path and SSR-hydration issues. This app has no SSR and no code path that ever passes attacker-controlled data into `<Link to=...>`/`useNavigate()` (every `to`/`navigate` target is either a literal string or a backend-minted id, never raw user/redirect input) — not reachable in this app's actual usage | 6.30.6 (non-major) fixes the two most severe (High/XSS) advisories | None — drop-in | **Upgraded** to 6.30.6 | 2 moderate advisories (open-redirect via backslash in `<Link>`; SSR hydration deserialization) remain, fixable only via a v7 major upgrade. Not reachable here (no SSR at all; no attacker-controlled redirect target) — documented, not silently ignored |
| `esbuild` (via `vite`) | bundled in vite 5.4.6 | Moderate | Dev dependency, transitive | **No** — `vite`/`esbuild` are never copied into the runtime container (`Dockerfile.control-center` copies only `dist/`/built static output) | **Yes** | Advisory is "any website can send requests to the `vite` dev server and read the response" — the dev server is never run in production (confirmed by Dockerfile inspection) | Full fix requires vite 8 (major) | react-router-dom's own peer requirements and this project's Vite 5 config would need re-validation for a v8 jump | Upgraded `vite` to 5.4.21 and `@vitejs/plugin-react` to 4.7.0 (both non-major, available fixes within the current majors) | Remaining `esbuild`/`vite` advisory requires a major bump; build-time-only, never reachable in the deployed BFF/browser runtime — documented |
| `@vitejs/plugin-react` | 4.3.1 | Moderate | Dev dependency | No | Yes | Same as above (transitively depends on vulnerable vite range) | 4.7.0 (non-major) | None | **Upgraded** | Resolved |

**Post-upgrade state**: 4 vulnerabilities (3 moderate, 1 high) remain, all requiring a MAJOR version bump
(`react-router-dom` 6→7, `vite` 5→8) to fully close, and none reachable in this deployment's actual runtime
paths (browser: no attacker-controlled redirect input anywhere in this codebase; build tool: never shipped).
`npm audit fix --force` was deliberately NOT run — no breaking major upgrade was applied blindly. **No
high-severity finding reachable in the deployed BFF/browser runtime remains a blocker.** Full `npm run
check` (twice) and the full Playwright suite were re-run after both safe upgrades and are green (see
test reconciliation below).

## Factual limitations (preserved, not silently dropped)

- Some onboarding capabilities remain unavailable because no accepted client-facing backend capability
  exists for them (MCP registration/discovery is operator-only by design; test-action submission and
  bypass assessment have no accepted HTTP capability at all).
- Incidents are a live, tenant-scoped aggregation of existing authoritative conditions — not a durable
  Incident system of record.
- Notifications are polling-based, not WebSocket-based.
- This client UI does not replace the TNA Operator CLI/Console.
- `client-admin` is a Control-Center-scoped role; it is never TNA-operator authority.
- This UI does not certify legal, regulatory, contractual, or industry compliance.
- This UI does not prove system safety.
- The Recursive Improvement UI displays only real, tested backend evidence; missing benchmark numbers are
  never invented.
- A separate reverse-proxy hop (nginx or similar) in front of the BFF was not literally exercised in this
  pass' container verification — the BFF's own combined API+static serving (which such a proxy would sit in
  front of) was fully verified live.

## Test reconciliation

- Accepted baseline (Volume 12): 1015/1015
- Volume 13 `node:test` additions: 83
- **`node:test` total: 1098/1098 — 1098 PASS, 0 FAIL, 0 SKIP**
- `npm run check` (typecheck + lint + test) run twice with no cleanup between: identical results both times
- Playwright (separate runner): **25/25**
- Combined informational total (node:test + Playwright): 1123 executed, 1123 passed, 0 failed
- `npm run smoke:control-center:v01`: PASS
- `npm run demo:control-center:v01`: PASS (8/8 real flows, exit 0)
- Container verification (`deploy/docker/Dockerfile.control-center` + `compose.control-center.yaml`): PASS
  — both containers healthy; real login; real dashboard reflecting real Platform state over the container
  network; real compiled frontend served

## Existing accepted tags

Unchanged. `tna-recursive-improvement-v0.1` remains exactly as accepted. **No `tna-control-center-v0.1` tag
exists** — Volume 13 remains untagged and unfrozen per every instruction issued during its development.
Volume 14 has not been started.

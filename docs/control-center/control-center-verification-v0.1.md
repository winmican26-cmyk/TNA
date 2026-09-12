# Control Center Verification v0.1

## Test layers

1. **`node --test` (`tests/control-center/*.test.ts`)** — real HTTP against a real, spawned Control Center
   server in front of real, in-process backend stacks (Platform/Client Gateway/Ledger/Auditor/Improvement
   Governor), exactly mirroring every other accepted TNA app's own test convention. 83 tests.
2. **Playwright (`tests/e2e/*.spec.ts`)** — real Chromium, real compiled frontend bundle, real BFF, real
   in-process backends (`scripts/e2e-server.ts`), started via Playwright's own `webServer`. No route
   interception on any acceptance path; the one deliberate exception (`unknown-state.spec.ts`) is explicitly
   labeled as testing a hypothetical future backend value no accepted backend can currently produce. 25
   tests.
3. **`scripts/smoke-control-center-v01.ts`** — boots the real COMPILED BFF binary (not an imported
   function) in front of a real in-process Platform/Gate/Sentinel/Ledger stack; real login → dashboard →
   actions → evidence over HTTP.
4. **`scripts/demo-control-center-v01.ts`** — eight real, narrated flows against the real packaged BFF/real
   backends; every seeded value is a real precondition, every printed outcome is read back through the real
   BFF.
5. **Container verification** (`deploy/docker/Dockerfile.control-center`,
   `deploy/compose/compose.control-center.yaml`) — real `docker build` + `docker compose up` of the accepted
   `tna-platform` image alongside a new `tna-control-center` image, wired by a real tenant-registry file
   naming Platform's real in-network address. Verified live: both containers report `healthy`; a real user
   provisioned via `docker exec ... control-center-create-user.js`; real login; real dashboard reflecting
   real Platform component health fetched over the container network; the real compiled frontend served
   (never a dev server). One item not literally exercised in this pass: a separate reverse-proxy hop (nginx
   or similar) in front of the BFF — the BFF's own single-port API+static serving is what such a proxy would
   sit in front of, and is itself fully verified.

## Commands

```
npm run check                        # typecheck + lint + full node:test suite (run twice, no cleanup between)
npm run test:control-center:v01      # Volume 13 node:test suite only
npm run smoke:control-center:v01     # packaged BFF + packaged frontend smoke test
npm run demo:control-center:v01      # 8 real demo flows
npx playwright test                  # real-browser E2E suite (separate runner, own results)
```

## Results (this closure pass)

- Accepted baseline: 1015/1015
- Volume 13 `node:test` additions: 83
- `node:test` total: 1098/1098 — run twice, identical results both times
- Playwright: 25/25
- `npm run smoke:control-center:v01`: PASS
- `npm run demo:control-center:v01`: PASS (all 8 flows, exit 0)
- Container verification: PASS (see above)

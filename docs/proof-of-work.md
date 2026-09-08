# Proof of work — TNA Gate MVP v0.1

This is captured terminal output from a fresh verification run requested after implementation. The command was `npm run check`, followed by `npm run demo` only if checks succeeded. The command completed with exit code 0. Typecheck, ESLint and the first build completed successfully before the captured test output below.

The demonstration uses an in-memory database and a temporary loopback HTTP server. Its decision IDs are demonstration output, not records in the persistent production database. These automated checks are not an independent security audit.

```text
✔ forbidden shell (2.0839ms)
✔ unlisted tool (0.1915ms)
✔ undeclared resource (0.2215ms)
✔ unknown host (0.1414ms)
✔ host suffix spoof (0.5437ms)
✔ objective reinterpretation (0.4009ms)
✔ self envelope edit (0.2554ms)
✔ read permission used for write (0.4117ms)
✔ unknown agent contact (0.3597ms)
✔ secret access fails closed without broker (0.3604ms)
✔ blocks file escape "/etc/passwd" (0.6381ms)
✔ blocks file escape "/workspace/logs/../secrets/key" (0.2681ms)
✔ blocks file escape "/workspace/logs-evil/file" (0.2142ms)
✔ blocks file escape "/workspace/logs/%2e%2e/secret" (0.1593ms)
✔ blocks file escape "/workspace/logs/a\\..\\key" (0.1724ms)
✔ blocks file escape "/workspace/logs//a" (0.1801ms)
✔ blocks file escape "/workspace/logs/./a" (0.1654ms)
✔ blocks file escape "/workspace/logs/file\u0000" (0.1913ms)
✔ allows canonical file in writable subtree (0.3382ms)
✔ missing network destination cannot bypass host check (0.2018ms)
✔ explicit host deny overrides allow; wildcard means deny unlisted (0.1729ms)
✔ expired at exact expiry boundary (1.5526ms)
✔ revoked identity blocks (0.1807ms)
✔ missing envelope blocks (0.1625ms)
✔ cost ceiling holds including reserved spending (0.1785ms)
✔ exact cost ceiling permits (0.1867ms)
✔ runtime boundary blocks (0.2112ms)
✔ tool call ceiling blocks (0.2494ms)
✔ external request ceiling blocks (0.2023ms)
✔ retry ceiling blocks (0.1808ms)
✔ listed agent must also be registered (0.176ms)
✔ strict envelope accepts the versioned fixture (13.2034ms)
✔ canonical policy hash ignores object key insertion order (1.3184ms)
✔ valid request allows deterministically without mutation (0.6461ms)
✔ absent approval holds (0.4014ms)
✔ rejects unknown root fields (2.0683ms)
✔ rejects unknown nested fields (0.998ms)
✔ rejects unsupported version (0.7545ms)
✔ rejects ambiguous or forbidden action bindings (1.8927ms)
✔ rejects malformed costs and destinations (3.508ms)
(node:36016) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
✔ HTTP workflow: HOLD, approval, ALLOW, evidence retrieval, revocation (150.8932ms)
✔ governed agent cannot modify envelope, register identities, approve or revoke (32.7893ms)
✔ agent identity and decision reads are isolated (30.4547ms)
✔ approval roles cannot be forged or replaced by administrator (15.5016ms)
✔ approval is single-use even under concurrent requests (29.0509ms)
✔ approval binds exact resource, cost, destination and envelope issuance (22.2255ms)
✔ expired approvals hold and expired envelopes block (15.1263ms)
✔ concurrent spending cannot exceed budget; policy replacement preserves counters (34.8985ms)
✔ malformed requests, unknown fields and missing credentials fail closed (19.7112ms)
✔ credential separation rejects short and duplicate credentials (0.9698ms)
(node:16160) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
✔ every ALLOW/BLOCK/HOLD persists complete decision evidence (63.3939ms)
✔ evidence write failure rolls back decision and budget reservations (6.8703ms)
✔ state, revocation and evidence persist across restart; tampering is detected (46.6515ms)
ℹ tests 53
ℹ suites 0
ℹ pass 53
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 677.0245

> trust-no-agent@0.1.0 demo
> npm run build && node dist/scripts/demo.js


> trust-no-agent@0.1.0 build
> tsc -p tsconfig.json

(node:24760) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
HOLD: Valid approval required (dec_b68eb011-f489-4fe3-b110-2fa6c77e2ac1)
ALLOW: Action permitted by envelope (dec_d1b46b37-d3f7-43ec-8367-dae472b33402)
BLOCK: Tool shell.unrestricted is not permitted (dec_a8f3c64e-a6e2-41ee-b4de-bc1349c26072)
BLOCK: Agent has been revoked (dec_e3442fbb-66e9-4243-9497-8a3a78bf9a6e)
Demo passed: all four decisions recorded; no tools executed.
```


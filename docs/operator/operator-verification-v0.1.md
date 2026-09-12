# TNA Operator CLI & Deployment Academy v0.1 — Verification Summary

| Area | Real evidence |
|---|---|
| Real CLI process | `tests/operator/cli-client-gateway.test.ts` — spawns the compiled `dist/apps/tna-operator/src/main.js` binary for every test |
| Real HTTP | Every CLI test drives a real, separately spawned `tna-client-gateway` process over real HTTP |
| Role boundaries | viewer-cannot-create, operator-cannot-offboard, security-operator-can-revoke, admin-can-everything (`tests/operator/operator-units.test.ts`) |
| Redaction | admin bearer token absence proven across 7 distinct real command invocations; `redactDeep` unit-tested directly |
| Reason/confirm safety | `tenant offboard` without reason/confirm refused; wrong `--confirm` refused |
| Incident package | hashed, tenant-scoped, redacted — proven against a real collected package |
| Go-live assessment | 9 unit tests covering every blocking/non-blocking rule and the KNOWN_BYPASS invariant |
| Handoff | hash changes with content, no secret field, embeds the real go-live result |
| Explain | MCP_SCHEMA_DRIFT, SENTINEL_HOLD vs SENTINEL_TERMINATED, Gate BLOCK reasons |
| Academy labs | 5 real labs, each verified against real TNA state (Gate, MCP fixture, ClientStore, the packaged client gateway) |
| Lab safety | path-traversal rejection, ACADEMY_LAB_MODE gate, symlink-escape rejection (POSIX; skipped on Windows CI) |
| Real container | `deployment-container.test.ts` and `client-gateway-container.test.ts` still pass after adding `academy/` to the Docker build context |
| Existing regression | all 757 previously-accepted tests remain green |

Run `npm run check` (twice), `npm run test:academy:v01`, `npm run demo:academy:v01`,
`npm run demo:operator:v01`, `npm run smoke:operator:v01`. See
[proof-of-work-operator-v0.1.md](proof-of-work-operator-v0.1.md) for exact counts and output.

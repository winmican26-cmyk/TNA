# MVP v0.1 verification

Validated locally inside the TNA workspace using Node.js 24.14.0 and npm 11.9.0.

| Check | Result |
|---|---|
| TypeScript typecheck | PASS |
| ESLint | PASS |
| TypeScript build | PASS |
| Unit, abuse, evidence, and REST integration tests | 53 passed, 0 failed |
| Local HTTP demonstration | PASS: HOLD, approved ALLOW, forbidden-tool BLOCK, revoked-agent BLOCK |

Run `npm run check` and `npm run demo` to reproduce. Tests include real loopback HTTP requests, concurrent requests, a temporary SQLite database beneath `data/test`, persisted revocation across database restart, audit-chain tampering, and injected evidence-write failure with transaction rollback.

This validates the implemented local authorization MVP. It does not certify production deployment, tool execution containment, network interception, real secret brokerage, or resistance to a compromised host. See `docs/threat-model.md` for the trust boundary and deferred adapters.

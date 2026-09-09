# Proof of Work: TNA Gate v0.2

## Scope and status

This is the reproducible Vol 2 documentation/demo report for VAD Atom 4. It covers only the already implemented capability, broker, registry, secret fail-closed path, API wiring, evidence boundary, verification surfaces, and local demo. It is not a production certification.

## Files and architecture

Implemented source surfaces: `packages/capability-core/src/index.ts`, `packages/execution-broker/src/index.ts`, `apps/tna-gate-api/src/server.ts`, and `apps/tna-gate-api/src/main.ts`. The allowed documentation/demo surfaces describe them without adding features. Gate authorizes; the broker issues and redeems; the registry selects trusted handlers; SQLite stores decisions, consumption, execution summaries, and hash-chained transitions.

The Vol 2 routes are `POST /v1/capabilities`, `POST /v1/capabilities/redeem`, `GET /v1/executions/:id`, and `GET /v1/agents/:id/executions`. There is no direct tool route.

## Capability format and integrity

The exact version-1 payload has 16 fields: version, capability_id, execution_id, agent_id, decision_id, action, tool, resource, operation, destination, policy_hash, policy_issuance_id, issued_at, expires_at, single_use, and nonce. `policy_hash` identifies the policy contents and `policy_issuance_id` carries the stored policy revision. Canonical key-sorted JSON is MACed with HMAC-SHA256 and encoded as two base64url segments. The codec requires a 32-byte minimum key, defaults to a 30-second TTL, caps TTL at 60 seconds, and rejects expiry at or before the current time. No secret or reusable credential is in the token.

The local API uses `TNA_CAPABILITY_KEY`; the demo uses an ephemeral random in-memory key. KMS/HSM storage, rotation, and key identifiers are deliberately unimplemented.

## Registry, broker, and secrets

The server-owned registry hides handlers and binds `demo.deploy.execute` to `production.deploy`, infrastructure/write, no network, and no credentials. The demo handler writes only a temporary JSON artifact. The broker checks the stored ALLOW, current policy/revision, revocation, exact bindings, and single-use state. Secret-requiring tools fail closed without `SecretBroker`; no secret is printed or persisted.

States are `REQUESTED`, `AUTHORIZED`, `CAPABILITY_ISSUED`, `STARTED`, `SUCCEEDED`, `FAILED`, and `BLOCKED`. SQLite commits consumption and STARTED before invocation. Because SQLite cannot commit a real external side effect atomically, a post-side-effect evidence failure remains indeterminate and the capability stays consumed.

## Security boundaries and tests

The direct invocation boundary is honest: the HTTP route is absent/rejected and the public registry invocation path rejects, but this local implementation does not provide OS sandboxing or network interception. Revocation and policy expiry are rechecked immediately before redemption. SQLite transactions protect concurrent issuance/redemption and budget state. Audit hashing detects ordinary tampering, not a privileged database rewrite.

Relevant abuse/concurrency coverage includes forged/modified/expired capability rejection, binding mismatch, replay, stale policy, revocation, unknown tools, direct registry access, concurrent issuance/redemption, handler failure sanitization, missing evidence, and isolated execution reads. The 53 Vol 1 tests remain regression tests.

## Check results

Run exactly:

```powershell
npm run typecheck
npm run build
npm run demo:v02
npx eslint scripts/demo-v02.ts
```

Observed producer results: `npm run typecheck` passed; `npm run build` passed; `npx eslint scripts/demo-v02.ts` passed with no output; and `npm test` passed with `tests 80`, `pass 80`, `fail 0` (53 Vol 1 regression tests plus 27 focused Vol 2 tests). `npm run demo:v02` passed with the required seven state lines and printed only Node's SQLite experimental-feature warning.

## Demo contract and limitations

The compiled demo must print and assert: `BLOCK direct invocation`, `HOLD missing approval`, `ALLOW`, `CAPABILITY ISSUED`, `EXECUTION SUCCEEDED`, `REPLAY BLOCKED`, and `REVOKED CAPABILITY BLOCKED`. It uses loopback HTTP, memory SQLite, random credentials, a temporary artifact directory, no real external action, no secret output, and cleanup in `finally`.

Deliberately unimplemented scope: production adapters, OS/process isolation, network egress enforcement, real secrets/KMS/HSM, key rotation, rollback, termination, measured external cost, external evidence anchoring, human-attestation proof, and protection from a compromised Gate host.

# Trust No Agent — Volume 1

TNA Gate MVP **v0.1** implements Authority Envelope **v1.0**, agent credentials, deterministic authorization, independent approvals, revocation, and durable decision evidence. All project files and runtime data live under `C:\Users\mican\Documents\TNA`.

This is an authorization service. An `ALLOW` reserves budget and records a decision; it does not run a deployment or enforce an operating-system sandbox. Tool execution, network interception, ephemeral credential delivery, Sentinel, and the dashboard are outside this milestone.

## Run and verify

Requires Node.js 24+ and npm. Node's built-in SQLite module may print an experimental API warning.

```powershell
Set-Location C:\Users\mican\Documents\TNA
npm ci --ignore-scripts
npm run check
npm run demo
```

`check` runs typecheck, lint, build, unit tests, REST integration tests, and authorization abuse tests. `demo` starts a temporary loopback HTTP server, registers an agent, issues an envelope, verifies HOLD → approval → ALLOW, blocks a forbidden shell, revokes the agent, and verifies another BLOCK. It uses memory-only state and random credentials and executes no tools.

## Volume 2 status

Vol 2 adds short-lived HMAC-SHA256 capabilities, a server-owned execution broker and demo registry, single-use redemption, execution evidence, and fail-closed secret brokerage. The local demo is simulated: it writes only a temporary artifact, performs no external action, and proves direct invocation is rejected, approval is required, replay is blocked, and revocation blocks a capability.

```powershell
npm run demo:v02
```

See [the capability model](docs/capability-model-v1.md), [execution broker](docs/execution-broker.md), [Vol 2 threat model](docs/v0.2-threat-model.md), and [Vol 2 verification](docs/v0.2-verification.md). Production isolation, network enforcement, real secrets, KMS/HSM key custody, and external-side-effect reconciliation remain unimplemented.

## Volume 3 status

Vol 3 documents and demonstrates the local child-process runner, application-level Egress Guard, and strict canonical tool-input binding. Run `npm run demo:v03` for the harmless temporary-workspace demo. These controls do not claim OS sandboxing, kernel egress isolation, SSRF-proof behavior, or exactly-once external effects; see [the Vol 3 threat model](docs/v0.3-threat-model.md) and [verification](docs/v0.3-verification.md).

Start the persistent API from the same PowerShell session:

```powershell
$env:TNA_ADMIN_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
$env:TNA_RELEASE_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
$env:TNA_SECURITY_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
npm run build
npm start
```

The API listens at `http://127.0.0.1:4317`. Set `PORT` to override it. SQLite state lives in `data/tna.sqlite`, with WAL sidecar files. Keep control-plane credentials stable across restarts using your environment's secret storage; the commands above are for local development. Never give administrator or approver credentials to governed agents.

## Volume 4 status — VAD Engine

VAD Engine v0.1 (`packages/vad-core`, `vad-runtime`, `validation-gate`, `verifier-core`,
`model-adapter`, `apps/vad-engine`) implements deterministic atom specs, a runtime-owned attempt/cost/
clock budget, an independent verifier, and auditable human-decision override. Run
`npm run demo:vad:v01`. See [docs/vad/](docs/vad/) for the requirement matrix, threat model, and
proof-of-work.

## Volume 5 status — TNA Ledger (v0.1 accepted)

TNA Ledger (`packages/ledger-schema`, `ledger-core`, `ledger-store`, `ledger-integrity`,
`ledger-query`, `apps/tna-ledger`) is the machine-action provenance and evidence subsystem: a
strict, versioned event schema; per-stream hash chaining with monotonic sequencing; tenant
isolation; orphan/invariant rejection (no `CAPABILITY_REDEEMED` without a prior `CAPABILITY_ISSUED`,
etc.); Gate and VAD reconstruction from evidence alone; and portable, independently-verifiable JSON
export. It records evidence — it does not authorize (Gate) or verify correctness (VAD). Run
`npm run demo:ledger:v01`. **TNA Ledger v0.1 — Architecturally accepted with documented scope and
limitations** (tag `tna-ledger-v0.1`) — see [docs/ledger/proof-of-work-ledger-v0.1.md](docs/ledger/proof-of-work-ledger-v0.1.md)
and [docs/ledger/ledger-threat-model-v0.1.md](docs/ledger/ledger-threat-model-v0.1.md) for scope and
residual risk before relying on it; hash chaining is not a tamper-proof or WORM claim (see the
threat model's residual-risk section).

## Volume 6 status — TNA Sentinel (v0.1 in development)

TNA Sentinel (`packages/sentinel-schema`, `sentinel-policy`, `sentinel-signals`, `sentinel-engine`,
`sentinel-runtime`, `apps/tna-sentinel`) is the runtime behavioral defense and containment layer: it
continuously asks whether an already-authorized activity's observed behavior — tool, operation,
resource, destination, cost, runtime, and authority state — remains within the bounds that made
authorizing it acceptable, and can HOLD or TERMINATE it when it drifts. It does not decide whether an
action may begin (Gate) or whether produced work is correct (VAD); it records its own evidence into
TNA Ledger through a dedicated adapter. Run `npm run demo:sentinel:v01`. **Not yet accepted** — see
[docs/sentinel/proof-of-work-sentinel-v0.1.md](docs/sentinel/proof-of-work-sentinel-v0.1.md) and
[docs/sentinel/sentinel-threat-model-v0.1.md](docs/sentinel/sentinel-threat-model-v0.1.md) before
relying on it; it cannot observe or contain behavior on a compromised host, and a lack of detected
violations is not proof that none occurred (see the threat model's observability limitation).

## Repository

```text
apps/tna-gate-api/          REST server, control plane, transactional orchestration
packages/shared-schema/    Strict request and response types
packages/authority-envelope/ Envelope validation, canonical hashes, file scopes
packages/policy-engine/    Deterministic, side-effect-free decision rules
packages/agent-identity/   Random bearer credentials and token hashing
packages/evidence-core/    SQLite transactions and hash-chained audit events
tests/authorization/      Schema and policy tests
tests/abuse-cases/         Adversarial authorization tests
tests/violations/          Evidence integrity, failure, restart tests
tests/integration/         Authenticated REST workflows and concurrency tests
scripts/demo.ts           Executable local HTTP demonstration
examples/                 Versioned deployment envelope and request
docs/                     Specification, API contract, threat model, design source
```

The workspace packages are private TypeScript source packages. The root build emits the complete monorepo to `dist/`; they are not independently published npm libraries.

## Security contract

- Agent registration, policy issuance, and revocation require the administrator credential.
- Approval requires a separate credential with the exact approver role. Even the administrator cannot use the approval endpoint with its administrator credential.
- Authorization requires an agent credential matching `agentId`. Agent credentials are returned once at registration; only their SHA-256 hashes are stored.
- Approvals bind the exact request, policy hash, and policy issuance. They expire and are consumed once. Reissuing a policy invalidates earlier approvals, even if its contents are identical.
- Lifetime usage counters survive restarts and policy replacement. Revocation is permanent for an agent ID in v0.1; register a new ID for a new lifecycle.
- Evidence, approval consumption, and usage reservations commit in one SQLite transaction. A failed evidence write prevents an ALLOW response.
- Explicit action bindings prevent agents from reinterpreting prose objectives. Unknown schema fields, unknown actions, undeclared resources, and unapproved hosts fail closed.

Read [the envelope specification](docs/authority-envelope-v1.md), [API contract](docs/api.md), and [threat model](docs/threat-model.md) before integrating an executor. The preserved Volume 1 brief is in [docs/volume-1-design.md](docs/volume-1-design.md).

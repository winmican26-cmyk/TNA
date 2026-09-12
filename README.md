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

## Volume 6 status — TNA Sentinel (v0.1 accepted)

TNA Sentinel (`packages/sentinel-schema`, `sentinel-policy`, `sentinel-signals`, `sentinel-engine`,
`sentinel-runtime`, `apps/tna-sentinel`) is the runtime behavioral defense and containment layer: it
continuously asks whether an already-authorized activity's observed behavior — tool, operation,
resource, destination, cost, runtime, and authority state — remains within the bounds that made
authorizing it acceptable, and can HOLD or TERMINATE it when it drifts. It does not decide whether an
action may begin (Gate) or whether produced work is correct (VAD); it records its own evidence into
TNA Ledger through a dedicated adapter. Run `npm run demo:sentinel:v01`. **TNA Sentinel v0.1 —
Architecturally accepted with documented scope and limitations** (tag `tna-sentinel-v0.1`) — see
[docs/sentinel/proof-of-work-sentinel-v0.1.md](docs/sentinel/proof-of-work-sentinel-v0.1.md) and
[docs/sentinel/sentinel-threat-model-v0.1.md](docs/sentinel/sentinel-threat-model-v0.1.md) for scope
and residual risk before relying on it; it cannot observe or contain behavior on a compromised host,
and a lack of detected violations is not proof that none occurred (see the threat model's
observability limitation).

## Volume 7 status — TNA Auditor (v0.1 accepted)

TNA Auditor (`packages/auditor-schema`, `auditor-controls`, `auditor-evidence`, `auditor-risk`,
`auditor-engine`, `auditor-report`, `apps/tna-auditor`) is the governance and control-assessment
layer: given a bounded scope and evidence cutoff, it collects evidence from TNA Ledger, evaluates a
27-control catalog against it, and produces a deterministic, hash-verifiable audit package — pass,
partial, fail, not-applicable, insufficient-evidence, or error per control, never a fabricated pass
from absent or corrupt evidence. It does not authorize activity (Gate), execute containment
(Sentinel), rewrite evidence (Ledger), or verify VAD outputs. Run `npm run demo:auditor:v01`. **TNA
Auditor v0.1 — Architecturally accepted with documented scope and limitations** (tag
`tna-auditor-v0.1`) — see
[docs/auditor/proof-of-work-auditor-v0.1.md](docs/auditor/proof-of-work-auditor-v0.1.md) and
[docs/auditor/auditor-threat-model-v0.1.md](docs/auditor/auditor-threat-model-v0.1.md) for scope and
residual risk before relying on it. **TNA Auditor evaluates configured controls against available
evidence — it does not certify legal, regulatory, contractual, or industry compliance** (no ISO 27001,
SOC 2, NIST, EU AI Act, DORA, HIPAA, GDPR, NIS2, or PCI DSS status is claimed).

## Volume 8 status — TNA Platform Integration v0.1 — Architecturally accepted with documented scope and limitations

TNA Platform Integration (`packages/platform-schema`, `platform-outbox`, `platform-connectors`,
`platform-core`, `apps/tna-platform`) is the end-to-end control plane: one governed
`PlatformActionRequest` moves through Gate authorization, capability issuance, a Sentinel session and
mandatory pre-action check, broker-mediated connector execution, optional VAD verification, and
durable Ledger evidence delivery via a transactional outbox — without the caller manually coordinating
the five accepted subsystems. It orchestrates; it does not replace any of Gate/VAD/Ledger/Sentinel/
Auditor's own accepted logic, and Auditor remains strictly post-hoc, never in the critical execution
path. Run `npm run demo:platform:v01`. See
[docs/platform/proof-of-work-platform-v0.1.md](docs/platform/proof-of-work-platform-v0.1.md) and
[docs/platform/platform-threat-model-v0.1.md](docs/platform/platform-threat-model-v0.1.md) for full
scope and residual risk before relying on it; it does not provide one ACID transaction across the five
subsystems it coordinates, and cannot universally roll back a connector's non-idempotent side effect
once performed (see the threat
model's distributed-transaction and connector-side-effect limitations).

## Volume 9 status — TNA Deployment Engineering v0.1 — Architecturally accepted with documented scope and limitations

TNA Deployment Engineering (`packages/deployment-schema`, `deployment-health`, `deployment-ops`,
`deploy/`, deployment additions to `apps/tna-platform`) makes the accepted platform reproducibly
deployable, operable, recoverable, and safely configurable — without weakening any security boundary
accepted in Volumes 1-8. It covers strict fail-closed configuration, a secret-reference model, a
non-root read-only-rootfs container, liveness/readiness health, structured redacted logging and bounded
metrics, and a backup/restore/upgrade/rollback model whose cross-component consistency is guaranteed by
requiring the deployment to be stopped while a backup is taken (see the recovery-consistency closure in
[docs/deployment/deployment-v0.1-recovery-consistency-closure.md](docs/deployment/deployment-v0.1-recovery-consistency-closure.md)).
Run `npm run demo:deployment:v01`. See
[docs/deployment/proof-of-work-deployment-v0.1.md](docs/deployment/proof-of-work-deployment-v0.1.md) and
[docs/deployment/deployment-threat-model-v0.1.md](docs/deployment/deployment-threat-model-v0.1.md) for
full scope and residual risk before relying on it; it is single-host and SQLite-based, not HA, not
multi-region, not Kubernetes production infrastructure, not managed cloud, not internet-scale DDoS
mitigation, not HSM/KMS-backed by default, and not a production/compliance certification of any kind.

## Volume 10 status — TNA Client Integration & MCP Gateway v0.1 — Architecturally accepted with documented scope and limitations

TNA Client Integration & MCP Gateway (`packages/client-schema`, `client-core`, `mcp-schema`,
`mcp-gateway`, `apps/tna-client-gateway`) lets TNA govern a real external client organization's agents
and tools over a real MCP (Model Context Protocol) stdio connection: tenant bootstrapping, service
identity and credential lifecycle, MCP server registration and discovery, a governed tool model with
automatic schema-drift detection, deterministic (non-LLM) risk classification, policy binding, and a
client-facing HTTP API. Real MCP child processes are spawned with `shell:false`, an explicit argv, and a
bounded environment allowlist; discovery and execution were proven against both a real spawned MCP
process and a real Docker container built from the same image as Volume 9, and the packaged production
entrypoint (`apps/tna-client-gateway/src/main.ts`) itself was proven end to end — real Gate ALLOW/BLOCK,
real Sentinel prevention, real MCP invocation, real Ledger evidence — through the actual compiled binary,
both bare and containerized. Run `npm run demo:client-integration:v01` and
`npm run smoke:client-integration:v01`. See
[docs/client-integration/proof-of-work-client-integration-v0.1.md](docs/client-integration/proof-of-work-client-integration-v0.1.md),
[docs/client-integration/client-integration-threat-model-v0.1.md](docs/client-integration/client-integration-threat-model-v0.1.md),
[docs/client-integration/client-integration-requirement-matrix-v0.1.md](docs/client-integration/client-integration-requirement-matrix-v0.1.md),
and
[docs/client-integration/client-integration-v0.1-packaged-path-closure.md](docs/client-integration/client-integration-v0.1-packaged-path-closure.md)
for full scope and residual risk before relying on it. **TNA Client Integration & MCP Gateway v0.1 —
Architecturally accepted with documented scope and limitations** (tag `tna-client-integration-v0.1`).
MCP server code is not inherently trusted and TNA cannot observe its internal behavior; TNA cannot
guarantee complete mediation if a client retains parallel credentials or direct access to the governed
system; there is no binary attestation for MCP servers; client-hosted/single-host remains the concrete
v0.1 deployment baseline; and no SaaS hosting layer, billing, customer frontend, enterprise SSO/SCIM,
Kubernetes/multi-region infrastructure, or regulatory certification of any kind is claimed (see the
proof-of-work's "Architectural Acceptance" section for the complete list).

## Volume 11 status — TNA Operator Readiness & Deployment Academy v0.1 — candidate implementation, pending architectural acceptance

TNA Operator Readiness & Deployment Academy (`apps/tna-operator`, `academy/`) asks whether TNA can be
deployed, operated, diagnosed, and handed over by someone who did not build it. It adds a real operator
CLI (`tna`) over the already-accepted admin/operator HTTP surfaces of `apps/tna-platform` and
`apps/tna-client-gateway` — never direct database access — with an explicit 4-role authority model,
read-only diagnostics (`tna doctor`), a hashed and redacted incident-package collector, a deterministic
`ClientGoLiveAssessment` and `ClientDeploymentHandoff`, and a full Deployment Academy: all 15 hands-on
labs run against actual TNA code, a 120-question bank, and 4 deterministic, non-self-reported level
assessments. Run `npm run demo:operator:v01`, `npm run smoke:operator:v01`, and
`npm run demo:academy:v01` (a genuine fresh-learner golden path through all 4 levels). See
[docs/operator/proof-of-work-operator-v0.1.md](docs/operator/proof-of-work-operator-v0.1.md) and
[docs/operator/operator-requirement-matrix-v0.1.md](docs/operator/operator-requirement-matrix-v0.1.md)
for full scope and residual risk. **TNA Operator Readiness & Deployment Academy v0.1 — candidate
implementation, pending architectural acceptance review.** It is not yet tagged. Remaining honest gaps
(long-form narrative lesson prose per curriculum topic, a handful of Volume 11-only edge cases) are listed
in the proof-of-work's "Remaining Limitations" — none of them are mandatory-gate items.

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

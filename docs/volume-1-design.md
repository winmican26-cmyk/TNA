# Volume 1 - Original Design and Build Brief

Here is the v1.0 design I would put into the book and build into software.

version: "1.0"

agent:
  id: "deployment-agent-17"
  name: "Deployment Agent"
  role: "deployment"
  owner: "platform-team"
  environment: "production"
  expires_at: "2026-09-09T01:00:00Z"

objective:
  task_id: "deploy-api-2026-09-08"
  goal: "Deploy approved API release to production"
  allowed_outcomes:
    - "deploy approved release"
    - "run post-deploy health checks"
  forbidden_outcomes:
    - "modify application source"
    - "change infrastructure topology"
    - "rotate unrelated secrets"

resources:
  repositories:
    read:
      - "org/api"
    write: []

  files:
    read:
      - "/workspace/build/**"
    write:
      - "/workspace/logs/**"

  databases:
    read:
      - "prod.health"
    write: []

  infrastructure:
    read:
      - "prod.cluster.status"
    write:
      - "prod.deploy.release"

tools:
  allow:
    - "github.read_release"
    - "ci.read_build"
    - "deploy.execute"
    - "healthcheck.run"
  deny:
    - "shell.unrestricted"
    - "secret.create"
    - "iam.modify"

network:
  allow:
    - "api.github.com"
    - "deploy.internal.company"
    - "health.internal.company"
  deny:
    - "*"

secrets:
  allow:
    - name: "prod_deploy_token"
      mode: "ephemeral"
      ttl_seconds: 600
  deny:
    - "*"

agents:
  communicate_with:
    - "security-verifier"
  communication_mode: "authenticated"
  shared_memory: false
  deny_unknown_agents: true

limits:
  max_runtime_seconds: 600
  max_tool_calls: 40
  max_external_requests: 20
  max_cost_usd: 3.00
  max_retries_per_action: 2

approvals:
  required_for:
    - action: "production.deploy"
      approver_role: "human-release-manager"
    - action: "secret.access"
      approver_role: "security"

risk:
  level: "high"
  blast_radius: "production-service"
  rollback_required: true

evidence:
  capture:
    - "agent_identity"
    - "policy_hash"
    - "tool_calls"
    - "network_destinations"
    - "resources_read"
    - "resources_modified"
    - "secrets_accessed"
    - "approvals"
    - "verifier_verdict"
    - "cost"
    - "timestamps"
  retention_days: 2555

violation_policy:
  unknown_tool: "block"
  undeclared_resource: "block"
  unauthorized_agent_contact: "terminate"
  network_violation: "terminate"
  secret_violation: "terminate_and_rotate"
  cost_limit_exceeded: "pause_and_escalate"
  runtime_limit_exceeded: "terminate"

The decision engine should be brutally simple:

REQUEST
  ↓
Identify agent
  ↓
Load Authority Envelope
  ↓
Is envelope valid and unexpired?
  ├─ NO → BLOCK
  ↓
Is requested action within stated objective?
  ├─ NO → BLOCK
  ↓
Is tool permitted?
  ├─ NO → BLOCK
  ↓
Is target resource permitted?
  ├─ NO → BLOCK
  ↓
Does action require approval?
  ├─ YES → VERIFY APPROVAL
  │          ├─ missing → HOLD
  │          └─ valid → continue
  ↓
Are runtime / cost / action limits still valid?
  ├─ NO → PAUSE / TERMINATE
  ↓
ALLOW
  ↓
EXECUTE
  ↓
WRITE EVIDENCE RECORD

The first API surface can be tiny:

POST /v1/agents/register
POST /v1/envelopes
GET  /v1/envelopes/:agentId

POST /v1/authorize
POST /v1/approvals
POST /v1/revoke

GET  /v1/decisions/:id
GET  /v1/agents/:id/activity

And the core authorization request should look like:

{
  "agentId": "deployment-agent-17",
  "action": "production.deploy",
  "tool": "deploy.execute",
  "resource": "prod.deploy.release",
  "destination": "deploy.internal.company",
  "estimatedCostUsd": 0.12
}

Response:

{
  "decision": "ALLOW",
  "reason": "Action permitted by envelope",
  "decisionId": "dec_01JXYZ",
  "policyVersion": "1.0",
  "requiresEvidence": true
}

Or:

{
  "decision": "BLOCK",
  "reason": "Tool shell.unrestricted is not permitted",
  "decisionId": "dec_01JABC",
  "severity": "high"
}

For the first build, I would use one shared monorepo and keep it intentionally small:

trust-no-agent/
├── apps/
│   └── tna-gate-api/
│
├── packages/
│   ├── authority-envelope/
│   ├── policy-engine/
│   ├── agent-identity/
│   ├── evidence-core/
│   └── shared-schema/
│
├── tests/
│   ├── authorization/
│   ├── violations/
│   └── abuse-cases/
│
└── docs/
    ├── authority-envelope-v1.md
    └── threat-model.md

The first threat model should cover exactly these attack classes:

agent uses an undeclared tool
agent accesses undeclared file/resource
agent calls an unapproved external host
agent attempts to contact another agent outside policy
agent attempts secret access
agent keeps running after expiry
agent exceeds cost or tool-call limits
agent tries to reinterpret its objective
agent obtains stale approval
agent attempts to alter its own envelope

The most important engineering rule is this:

The agent must never be able to edit, widen, or reinterpret its own Authority Envelope.

That belongs outside the agent runtime, just like your book already argues that producer and verifier roles must be structurally separated rather than trusted to behave correctly by prompt.

The next concrete milestone is therefore TNA Gate MVP v0.1:

Agent identity + Authority Envelope parser + authorization engine + approval gate + violation logging + tests.

Once those are working, we add network enforcement, ephemeral credentials, agent-to-agent authentication, and the first Sentinel hooks.

I would keep all project work under the folder you gave:

C:\Users\mican\Documents\TNA

and treat that as the root of the new platform.

ye sor know. should I scarfold and implement this ?

Yes — scaffold and implement it now.

Do not start by trying to build the entire Trust No Agent platform. Build only the TNA Gate MVP v0.1 first, inside:

C:\Users\mican\Documents\TNA

The goal of v0.1 is simple: prove that an agent can make a request, TNA Gate can decide ALLOW / BLOCK / HOLD, and every decision is recorded.

Your first implementation scope should be:

Monorepo scaffold
apps/tna-gate-api
packages/shared-schema
packages/authority-envelope
packages/policy-engine
packages/agent-identity
packages/evidence-core
Authority Envelope schema
Zod or JSON Schema
strict validation
versioned as 1.0
reject unknown fields where sensible

Authorization engine
Inputs:

agent ID
action
tool
resource
destination
estimated cost

Outputs:

ALLOW
BLOCK
HOLD
Rules implemented first
expired envelope → BLOCK
unknown tool → BLOCK
undeclared resource → BLOCK
unauthorized destination → BLOCK
unauthorized agent communication → BLOCK
approval required but absent → HOLD
max cost exceeded → BLOCK/HOLD
valid request → ALLOW
Evidence logging
Every authorization decision records:
decision ID
agent ID
envelope version/hash
requested action
tool
resource
decision
reason
timestamp
approval reference if any
Minimal REST API
POST /v1/agents/register
POST /v1/envelopes
POST /v1/authorize
POST /v1/approvals
POST /v1/revoke
GET /v1/decisions/:id
Tests
Build abuse cases before UI:
agent tries forbidden shell
agent writes outside its resource scope
agent contacts unknown host
agent contacts unauthorized agent
agent uses expired envelope
agent deploys without approval
agent exceeds cost ceiling
agent attempts to modify its own envelope

And one important constraint: do not build the dashboard yet. A pretty dashboard can make an incomplete security product feel finished. First make the policy engine hard to bypass.

If you're giving this to your coding agent, I would start it with this exact mission:

Scaffold and implement TNA Gate MVP v0.1 in C:\Users\mican\Documents\TNA. Build a production-quality TypeScript monorepo containing agent identity, Authority Envelope v1.0 validation, a deterministic authorization policy engine, approval handling, revocation, evidence logging, REST API endpoints, and comprehensive security/abuse tests. The agent being governed must never be able to modify or expand its own Authority Envelope. Do not build Sentinel, Ledger UI, Auditor, VAD orchestration, or a frontend yet. Finish only when build, typecheck, lint, unit tests, integration tests, and authorization abuse cases are green.
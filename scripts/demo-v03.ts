import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execPath } from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EgressError, EgressGuard } from '../packages/egress-guard/src/index.js';
import { CapabilityCodec } from '../packages/capability-core/src/index.js';
import { BrokerError, ExecutionBroker, ToolRegistry, createDemoRegistry, type ToolDefinition } from '../packages/execution-broker/src/index.js';
import { Store } from '../packages/evidence-core/src/index.js';
import { ChildProcessIsolationRunner, IsolationError, type IsolatedExecutionRequest } from '../packages/isolation-runner/src/index.js';
import { ToolInputRegistry, demoToolInputMetadata } from '../packages/tool-inputs/src/index.js';
import type { Decision } from '../packages/shared-schema/src/index.js';

const agent = { kind: 'agent', agentId: 'demo-v03-agent' } as const;
const input = { release: 'release-v03', environment: 'demo-production' };
const inputs = new ToolInputRegistry();
inputs.register(demoToolInputMetadata);
const inputHash = inputs.parseAndHash('demo.deploy.execute', input).input_hash;
const request = { agentId: agent.agentId, action: 'production.deploy', tool: 'demo.deploy.execute', resource: input.release, estimatedCostUsd: 0, input, input_hash: inputHash };

function decision(decisionId: string): Decision {
  return { decisionId, agentId: agent.agentId, decision: 'ALLOW', reason: 'demo authorization', severity: 'info', policyVersion: 'v0.3-demo', policyHash: 'demo-policy', requiresEvidence: true, timestamp: new Date().toISOString(), request, approvalReference: null };
}

function baseRequest(workspace: string, script: string, overrides: Partial<IsolatedExecutionRequest> = {}): IsolatedExecutionRequest {
  return { execution_id: randomUUID(), agent_id: agent.agentId, tool: 'demo.deploy.execute', operation: 'write', command: execPath, args: [script], workspace, cwd: '.', env: {}, runtime_limit_ms: 1_000, stdout_limit_bytes: 4_096, stderr_limit_bytes: 4_096, output_limit_bytes: 8_192, no_network: { requested: true, mode: 'preflight-only' }, ...overrides };
}

const store = new Store(':memory:');
const root = await mkdtemp(join(tmpdir(), 'tna-v03-demo-'));
const artifacts = join(root, 'artifacts');
const runner = new ChildProcessIsolationRunner();
let revoked = false;
const registry = createDemoRegistry(artifacts);
const broker = new ExecutionBroker(store, new CapabilityCodec(randomBytes(32)), registry, { isolationRunner: runner, isAgentRevoked: () => revoked });

try {
  const directRegistry = new ToolRegistry();
  directRegistry.register({ name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [] } satisfies ToolDefinition);
  await assert.rejects(() => directRegistry.invoke('demo.deploy.execute', {} as never), /broker-only/);
  process.stdout.write('BLOCK DIRECT TOOL INVOCATION\n');

  store.put('decision', 'demo-decision-1', decision('demo-decision-1'));
  const issued = broker.issue(agent, 'demo-decision-1');
  process.stdout.write('ALLOW AUTHORIZATION\nCAPABILITY ISSUED\n');
  await assert.rejects(() => broker.redeem(agent, { token: issued.token, tool: request.tool, resource: request.resource, operation: 'write', input: { ...input, release: 'release-substituted' }, input_hash: inputHash }), (error: unknown) => error instanceof BrokerError && /binding|consumed/.test(error.message));
  process.stdout.write('INPUT SUBSTITUTION BLOCKED\n');

  await broker.redeem(agent, { token: issued.token, tool: request.tool, resource: request.resource, operation: 'write', input, input_hash: inputHash });
  process.stdout.write('ISOLATED EXECUTION STARTED\nEXECUTION SUCCEEDED\n');

  await assert.rejects(() => runner.run(baseRequest(root, '-e', { cwd: '../' })), (error: unknown) => error instanceof IsolationError && error.code === 'INVALID_CWD');
  process.stdout.write('FILESYSTEM ESCAPE BLOCKED\n');

  let fetchCalls = 0;
  const egress = new EgressGuard({ mode: 'none', allowHosts: [] }, { fetch: async () => { fetchCalls++; return new Response(); } });
  await assert.rejects(() => egress.request('https://example.invalid/'), (error: unknown) => error instanceof EgressError && error.decision.reason === 'NETWORK_DISABLED');
  assert.equal(fetchCalls, 0);
  process.stdout.write('NETWORK EGRESS BLOCKED\n');

  const timeoutScript = join(root, 'timeout.mjs');
  await writeFile(timeoutScript, 'setInterval(() => {}, 1000);\n', 'utf8');
  const timeout = await runner.run(baseRequest(root, timeoutScript, { runtime_limit_ms: 50 }));
  assert.equal(timeout.state, 'TERMINATED');
  assert.equal(timeout.reason, 'runtime_limit');
  process.stdout.write('TIMEOUT TERMINATED\n');

  store.put('decision', 'demo-decision-2', decision('demo-decision-2'));
  const revokedCapability = broker.issue(agent, 'demo-decision-2');
  revoked = true;
  await assert.rejects(() => broker.redeem(agent, { token: revokedCapability.token, tool: request.tool, resource: request.resource, operation: 'write', input, input_hash: inputHash }), /revoked/);
  process.stdout.write('REVOKED EXECUTION BLOCKED\n');
  store.verifyEvidence();
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}

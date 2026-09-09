import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, createDemoRegistry } from '../../packages/execution-broker/src/index.js';
import { ChildProcessIsolationRunner } from '../../packages/isolation-runner/src/index.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { createGateServer, type Credentials } from '../../apps/tna-gate-api/src/server.js';
import { envelope, request, NOW } from '../fixture.js';
import { ToolInputRegistry, demoToolInputMetadata } from '../../packages/tool-inputs/src/index.js';

const admin = 'a'.repeat(40), release = 'r'.repeat(40);
const credentials: Credentials = { adminToken: admin, approvers: [{ token: release, role: 'human-release-manager' }] };
const input = { release: 'prod.deploy.release', environment: 'demo-production' };
const inputRegistry = new ToolInputRegistry();
inputRegistry.register(demoToolInputMetadata);
const inputHash = inputRegistry.parseAndHash('demo.deploy.execute', input).input_hash;

function demoEnvelope() {
  const value = envelope();
  value.agent.expires_at = '2026-09-10T01:00:00Z';
  value.tools.allow.push('demo.deploy.execute');
  value.action_bindings[0]!.tool = 'demo.deploy.execute';
  value.action_bindings[0]!.destination_required = false;
  return value;
}
function demoRequest() { return { agentId: request().agentId, action: 'production.deploy', tool: 'demo.deploy.execute', resource: input.release, estimatedCostUsd: 0, input, input_hash: inputHash }; }

async function setup(t: TestContext) {
  const store = new Store(':memory:');
  const gate = new Gate(store, () => NOW);
  const artifacts = mkdtempSync(resolve('data', 'api-v03-'));
  const broker = new ExecutionBroker(store, new CapabilityCodec(randomBytes(32), { clock: () => NOW }), createDemoRegistry(artifacts), {
    isolationRunner: new ChildProcessIsolationRunner(),
    isAgentRevoked: agentId => gate.isAgentRevoked(agentId),
    isPolicyCurrent: decision => gate.isPolicyCurrent(decision),
    isDecisionCurrent: decision => gate.isPolicyCurrent(decision),
  });
  const server = createGateServer(gate, credentials, broker);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); store.close(); rmSync(artifacts, { recursive: true, force: true }); });
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  async function call(path: string, token: string, body?: unknown) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  const registered = await call('/v1/agents/register', admin, { id: request().agentId, name: 'Deployment Agent' });
  assert.equal(registered.status, 201);
  const agentToken = String(registered.data.token);
  assert.equal((await call('/v1/envelopes', admin, demoEnvelope())).status, 201);
  return { call, agentToken, artifacts };
}

test('v0.3 API executes the registered demo only in a child and exposes bounded isolation evidence', async t => {
  const { call, agentToken, artifacts } = await setup(t);
  const pending = await call('/v1/authorize', agentToken, demoRequest());
  assert.equal(pending.data.decision, 'HOLD');
  const approval = await call('/v1/approvals', release, { request: demoRequest(), expiresAt: '2026-09-09T12:00:30.000Z' });
  assert.equal(approval.status, 201, JSON.stringify(approval.data));
  const allowed = await call('/v1/authorize', agentToken, { ...demoRequest(), approvalId: approval.data.approvalId });
  const issued = await call('/v1/capabilities', agentToken, { decisionId: allowed.data.decisionId });
  const redeem = await call('/v1/capabilities/redeem', agentToken, { token: issued.data.token, tool: 'demo.deploy.execute', resource: input.release, operation: 'write', input, input_hash: inputHash });
  assert.equal(redeem.status, 200, JSON.stringify(redeem.data));
  const executionId = String(redeem.data.executionId);
  const execution = await call(`/v1/executions/${executionId}`, agentToken);
  assert.equal(execution.status, 200);
  const evidence = execution.data.isolation as Record<string, unknown>;
  assert.equal(evidence.runner_type, 'child-process');
  assert.equal((evidence.network as Record<string, unknown>).enforcement, 'not-enforced');
  assert.equal(evidence.input_hash, inputHash);
  assert.equal('preview' in evidence, false);
  assert.equal(readFileSync(resolve(artifacts, executionId, `${executionId}.json`), 'utf8').includes('production.deploy'), true);
  assert.equal((await call('/v1/tools/demo.deploy.execute', agentToken, demoRequest())).status, 404);
});

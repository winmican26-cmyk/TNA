import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, createDemoRegistry } from '../../packages/execution-broker/src/index.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { createGateServer, type Credentials } from '../../apps/tna-gate-api/src/server.js';
import { envelope, request, NOW } from '../fixture.js';

const admin = 'a'.repeat(40), release = 'r'.repeat(40);
const credentials: Credentials = { adminToken: admin, approvers: [{ token: release, role: 'human-release-manager' }] };

function demoEnvelope(expiresAt = '2026-09-10T01:00:00Z') {
  const value = envelope();
  value.agent.expires_at = expiresAt;
  value.tools.allow.push('demo.deploy.execute');
  value.action_bindings[0]!.tool = 'demo.deploy.execute';
  value.action_bindings[0]!.destination_required = false;
  return value;
}
function demoRequest() { return { agentId: request().agentId, action: 'production.deploy', tool: 'demo.deploy.execute', resource: 'prod.deploy.release', estimatedCostUsd: 0.12 }; }

async function setup(t: TestContext, withBroker = true, envelopeExpiresAt = '2026-09-10T01:00:00Z') {
  let clock = NOW;
  const store = new Store(':memory:');
  const gate = new Gate(store, () => clock);
  const artifactDirectory = mkdtempSync(resolve('data', 'api-v02-'));
  const broker = withBroker ? new ExecutionBroker(store, new CapabilityCodec(randomBytes(32), { clock: () => clock }), createDemoRegistry(artifactDirectory), {
    now: () => clock,
    isAgentRevoked: agentId => gate.isAgentRevoked(agentId),
    isPolicyCurrent: decision => gate.isPolicyCurrent(decision),
    isDecisionCurrent: decision => gate.isPolicyCurrent(decision),
  }) : undefined;
  const server = createGateServer(gate, credentials, broker);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    store.close();
    rmSync(artifactDirectory, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  async function call(path: string, token: string, input?: unknown) {
    const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  const registered = await call('/v1/agents/register', admin, { id: request().agentId, name: 'Deployment Agent' });
  assert.equal(registered.status, 201);
  const agentToken = String(registered.data.token);
  assert.equal((await call('/v1/envelopes', admin, demoEnvelope(envelopeExpiresAt))).status, 201);
  async function allow() {
    const pending = await call('/v1/authorize', agentToken, demoRequest());
    assert.equal(pending.data.decision, 'HOLD');
    const approval = await call('/v1/approvals', release, { request: demoRequest(), expiresAt: new Date(Math.min(clock + 60_000, Date.parse(envelopeExpiresAt))).toISOString() });
    assert.equal(approval.status, 201, JSON.stringify(approval.data));
    const allowed = await call('/v1/authorize', agentToken, { ...demoRequest(), approvalId: approval.data.approvalId });
    assert.equal(allowed.data.decision, 'ALLOW');
    return { decisionId: String(allowed.data.decisionId), allow: allowed.data };
  }
  return { call, store, agentToken, allow, setTime: (time: number) => { clock = time; } };
}

test('Vol 1 authorization routes remain usable and Vol 2 workflow issues and redeems a capability', async t => {
  const { call, agentToken, allow } = await setup(t);
  const workflow = await allow();
  assert.equal((await call('/v1/decisions/' + workflow.decisionId, agentToken)).status, 200);
  const issued = await call('/v1/capabilities', agentToken, { decisionId: workflow.decisionId });
  assert.equal(issued.status, 201);
  assert.equal(typeof issued.data.token, 'string');
  assert.equal((issued.data.payload as Record<string, unknown>).agent_id, 'deployment-agent-17');
  const redeemed = await call('/v1/capabilities/redeem', agentToken, { token: issued.data.token, tool: 'demo.deploy.execute', resource: 'prod.deploy.release', operation: 'write' });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.data));
  assert.equal(redeemed.data.state, 'SUCCEEDED');
});

test('capability issuance and redemption fail closed for invalid state and replay', async t => {
  const { call, agentToken, allow } = await setup(t);
  const { decisionId } = await allow();
  assert.equal((await call('/v1/capabilities', agentToken, { decisionId, extra: true })).status, 400);
  const issued = await call('/v1/capabilities', agentToken, { decisionId });
  assert.equal((await call('/v1/capabilities/redeem', agentToken, { token: issued.data.token, tool: 'wrong', resource: 'prod.deploy.release', operation: 'write' })).status, 403);
  const input = { token: issued.data.token, tool: 'demo.deploy.execute', resource: 'prod.deploy.release', operation: 'write' };
  assert.equal((await call('/v1/capabilities/redeem', agentToken, input)).status, 200);
  assert.equal((await call('/v1/capabilities/redeem', agentToken, input)).status, 409);
});

test('expired envelopes block capability issuance and redemption', async t => {
  const envelopeExpiresAt = new Date(NOW + 10_000).toISOString();
  const { call, allow, setTime } = await setup(t, true, envelopeExpiresAt);
  const issuanceDecision = await allow();
  setTime(Date.parse(envelopeExpiresAt));
  const expiredIssuance = await call('/v1/capabilities', admin, { decisionId: issuanceDecision.decisionId });
  assert.deepEqual(expiredIssuance, { status: 403, data: { error: 'Decision is stale' } });

  setTime(NOW);
  const redemptionDecision = await allow();
  const issued = await call('/v1/capabilities', admin, { decisionId: redemptionDecision.decisionId });
  assert.equal(issued.status, 201);
  setTime(Date.parse(envelopeExpiresAt));
  assert.equal((await call('/v1/capabilities/redeem', admin, { token: issued.data.token, tool: 'demo.deploy.execute', resource: 'prod.deploy.release', operation: 'write' })).status, 403);
});

test('revoked and stale-policy capabilities cannot redeem, and execution reads are isolated', async t => {
  const { call, agentToken, allow } = await setup(t);
  const stale = await allow();
  const staleCapability = await call('/v1/capabilities', agentToken, { decisionId: stale.decisionId });
  assert.equal((await call('/v1/envelopes', admin, demoEnvelope())).status, 201);
  assert.equal((await call('/v1/capabilities/redeem', agentToken, { token: staleCapability.data.token, tool: 'demo.deploy.execute', resource: 'prod.deploy.release', operation: 'write' })).status, 403);
  const revoked = await allow();
  const revokedCapability = await call('/v1/capabilities', agentToken, { decisionId: revoked.decisionId });
  assert.equal((await call('/v1/revoke', admin, { agentId: request().agentId, reason: 'release complete' })).status, 200);
  assert.equal((await call('/v1/capabilities/redeem', agentToken, { token: revokedCapability.data.token, tool: 'demo.deploy.execute', resource: 'prod.deploy.release', operation: 'write' })).status, 403);
  await call('/v1/agents/register', admin, { id: 'other-agent', name: 'Other Agent' });
  assert.equal((await call('/v1/agents/other-agent/executions', agentToken)).status, 403);
});

test('missing broker fails closed while authorization remains available', async t => {
  const { call, agentToken, allow } = await setup(t, false);
  const { decisionId } = await allow();
  assert.equal((await call('/v1/capabilities', agentToken, { decisionId })).status, 503);
  assert.equal((await call('/v1/executions/missing', agentToken)).status, 503);
  assert.equal((await call('/v1/agents/deployment-agent-17/executions', agentToken)).status, 503);
});
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { envelopeSchema } from '../packages/authority-envelope/src/index.js';
import { ExecutionBroker, createDemoRegistry } from '../packages/execution-broker/src/index.js';
import { CapabilityCodec } from '../packages/capability-core/src/index.js';
import { Store } from '../packages/evidence-core/src/index.js';
import { Gate } from '../apps/tna-gate-api/src/gate.js';
import { createGateServer } from '../apps/tna-gate-api/src/server.js';

const adminToken = randomBytes(32).toString('hex');
const releaseToken = randomBytes(32).toString('hex');
const artifactDirectory = mkdtempSync(resolve('data', 'demo-v02-'));
const store = new Store(':memory:');
const gate = new Gate(store);
const broker = new ExecutionBroker(store, new CapabilityCodec(randomBytes(32)), createDemoRegistry(artifactDirectory), {
  isAgentRevoked: agentId => gate.isAgentRevoked(agentId),
  isPolicyCurrent: decision => gate.isPolicyCurrent(decision),
  isDecisionCurrent: decision => gate.isPolicyCurrent(decision),
});
const server = createGateServer(gate, { adminToken, approvers: [{ token: releaseToken, role: 'human-release-manager' }] }, broker);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

type ResponseData = { status: number; data: Record<string, unknown> };
async function call(path: string, token: string, body?: unknown): Promise<ResponseData> {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}
function expectStatus(response: ResponseData, status: number): void { assert.equal(response.status, status, JSON.stringify(response.data)); }

try {
  const envelope = envelopeSchema.parse(JSON.parse(readFileSync(new URL('../../examples/deployment-envelope.json', import.meta.url), 'utf8')));
  envelope.agent.id = `demo-v02-${randomUUID()}`;
  envelope.agent.expires_at = new Date(Date.now() + 600_000).toISOString();
  envelope.tools.allow = envelope.tools.allow.filter(tool => tool !== 'deploy.execute');
  envelope.tools.allow.push('demo.deploy.execute');
  envelope.action_bindings[0]!.tool = 'demo.deploy.execute';
  envelope.action_bindings[0]!.destination_required = false;
  envelope.network.allow = [];

  const registered = await call('/v1/agents/register', adminToken, { id: envelope.agent.id, name: envelope.agent.name });
  expectStatus(registered, 201);
  const agentToken = String(registered.data.token);
  expectStatus(await call('/v1/envelopes', adminToken, envelope), 201);

  const request = { agentId: envelope.agent.id, action: 'production.deploy', tool: 'demo.deploy.execute', resource: 'prod.deploy.release', estimatedCostUsd: 0.12 };
  const direct = await call('/v1/tools/demo.deploy.execute', agentToken, request);
  expectStatus(direct, 404);
  process.stdout.write('BLOCK direct invocation (HTTP 404 route rejected)\n');

  const hold = await call('/v1/authorize', agentToken, request);
  expectStatus(hold, 200);
  assert.equal(hold.data.decision, 'HOLD');
  process.stdout.write('HOLD missing approval\n');

  const approval = await call('/v1/approvals', releaseToken, { request, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  expectStatus(approval, 201);
  const allow = await call('/v1/authorize', agentToken, { ...request, approvalId: approval.data.approvalId });
  expectStatus(allow, 200);
  assert.equal(allow.data.decision, 'ALLOW');
  process.stdout.write('ALLOW\n');

  const issued = await call('/v1/capabilities', agentToken, { decisionId: allow.data.decisionId });
  expectStatus(issued, 201);
  assert.equal(typeof issued.data.token, 'string');
  process.stdout.write('CAPABILITY ISSUED\n');
  const redeemInput = { token: issued.data.token, tool: 'demo.deploy.execute', resource: request.resource, operation: 'write' };
  const succeeded = await call('/v1/capabilities/redeem', agentToken, redeemInput);
  expectStatus(succeeded, 200);
  assert.equal(succeeded.data.state, 'SUCCEEDED');
  process.stdout.write('EXECUTION SUCCEEDED\n');
  const artifact = readFileSync(resolve(artifactDirectory, `${String((issued.data.payload as Record<string, unknown>).execution_id)}.json`), 'utf8');
  assert(!artifact.includes('secret'));

  const replay = await call('/v1/capabilities/redeem', agentToken, redeemInput);
  expectStatus(replay, 409);
  process.stdout.write('REPLAY BLOCKED (HTTP 409 consumed)\n');

  const approvalTwo = await call('/v1/approvals', releaseToken, { request, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  expectStatus(approvalTwo, 201);
  const allowTwo = await call('/v1/authorize', agentToken, { ...request, approvalId: approvalTwo.data.approvalId });
  expectStatus(allowTwo, 200);
  assert.equal(allowTwo.data.decision, 'ALLOW');
  const issuedTwo = await call('/v1/capabilities', agentToken, { decisionId: allowTwo.data.decisionId });
  expectStatus(issuedTwo, 201);
  expectStatus(await call('/v1/revoke', adminToken, { agentId: envelope.agent.id, reason: 'Demo complete' }), 200);
  const revoked = await call('/v1/capabilities/redeem', agentToken, { ...redeemInput, token: issuedTwo.data.token });
  expectStatus(revoked, 403);
  process.stdout.write('REVOKED CAPABILITY BLOCKED (HTTP 403)\n');
  store.verifyEvidence();
  process.stdout.write('Demo v0.2 passed: no external action, secrets, or persistent temp state.\n');
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  store.close();
  rmSync(artifactDirectory, { recursive: true, force: true });
}

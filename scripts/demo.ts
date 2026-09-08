import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { envelopeSchema } from '../packages/authority-envelope/src/index.js';
import { Store } from '../packages/evidence-core/src/index.js';
import { Gate } from '../apps/tna-gate-api/src/gate.js';
import { createGateServer } from '../apps/tna-gate-api/src/server.js';

// Runs locally with ephemeral credentials and in-memory state; executes no deployment.
const adminToken = randomBytes(32).toString('hex');
const releaseToken = randomBytes(32).toString('hex');
const store = new Store(':memory:');
const server = createGateServer(new Gate(store), { adminToken, approvers: [{ token: releaseToken, role: 'human-release-manager' }] });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert(address && typeof address === 'object');
async function post(path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${(address as { port: number }).port}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json() as Record<string, unknown>;
  assert(response.ok, JSON.stringify(data)); return data;
}
try {
  const envelope = envelopeSchema.parse(JSON.parse(readFileSync(new URL('../../examples/deployment-envelope.json', import.meta.url), 'utf8')));
  envelope.agent.id = `demo-${randomUUID()}`;
  envelope.agent.expires_at = new Date(Date.now() + 600_000).toISOString();
  const registration = await post('/v1/agents/register', adminToken, { id: envelope.agent.id, name: envelope.agent.name });
  const agentToken = String(registration.token);
  await post('/v1/envelopes', adminToken, envelope);
  const request = { agentId: envelope.agent.id, action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', destination: 'deploy.internal.company', estimatedCostUsd: 0.12 };
  const hold = await post('/v1/authorize', agentToken, request); assert.equal(hold.decision, 'HOLD');
  const approval = await post('/v1/approvals', releaseToken, { request, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const allow = await post('/v1/authorize', agentToken, { ...request, approvalId: approval.approvalId }); assert.equal(allow.decision, 'ALLOW');
  const block = await post('/v1/authorize', agentToken, { ...request, tool: 'shell.unrestricted' }); assert.equal(block.decision, 'BLOCK');
  await post('/v1/revoke', adminToken, { agentId: envelope.agent.id, reason: 'Demo complete' });
  const revoked = await post('/v1/authorize', agentToken, request); assert.equal(revoked.decision, 'BLOCK');
  store.verifyEvidence();
  for (const decision of [hold, allow, block, revoked]) process.stdout.write(`${String(decision.decision)}: ${String(decision.reason)} (${String(decision.decisionId)})\n`);
  process.stdout.write('Demo passed: all four decisions recorded; no tools executed.\n');
} finally {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
}

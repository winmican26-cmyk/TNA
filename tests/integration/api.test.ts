import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGateServer } from '../../apps/tna-gate-api/src/server.js';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { envelope, request, NOW } from '../fixture.js';

const admin = 'a'.repeat(40), release = 'r'.repeat(40), security = 's'.repeat(40);
async function setup(t: TestContext) {
  let clock = NOW;
  const store = new Store(':memory:');
  const gate = new Gate(store, () => clock);
  const server = createGateServer(gate, { adminToken: admin, approvers: [{ token: release, role: 'human-release-manager' }, { token: security, role: 'security' }] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); });
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  async function call(path: string, token: string, input?: unknown) {
    const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const data = await response.json() as Record<string, unknown>;
    return { status: response.status, data };
  }
  const registered = await call('/v1/agents/register', admin, { id: request().agentId, name: 'Deployment Agent' });
  assert.equal(registered.status, 201);
  const token = String(registered.data.token);
  assert.equal((await call('/v1/envelopes', admin, envelope())).status, 201);
  const approve = async () => {
    const result = await call('/v1/approvals', release, { request: request(), expiresAt: new Date(clock + 60_000).toISOString() });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return String(result.data.approvalId);
  };
  return { call, token, approve, store, base, setTime: (time: number) => { clock = time; } };
}
test('HTTP workflow: HOLD, approval, ALLOW, evidence retrieval, revocation', async t => {
  const { call, token, approve } = await setup(t);
  assert.equal((await call('/v1/authorize', token, request())).data.decision, 'HOLD');
  const approvalId = await approve();
  const allowed = await call('/v1/authorize', token, { ...request(), approvalId });
  assert.equal(allowed.data.decision, 'ALLOW');
  assert.equal((await call(`/v1/decisions/${String(allowed.data.decisionId)}`, token)).data.approvalReference, approvalId);
  const activity = await call(`/v1/agents/${request().agentId}/activity`, token);
  assert.equal((activity.data as unknown as unknown[]).length, 2);
  assert.equal((await call(`/v1/envelopes/${request().agentId}`, token)).status, 200);
  assert.equal((await call('/v1/revoke', admin, { agentId: request().agentId, reason: 'Release complete' })).status, 200);
  assert.equal((await call('/v1/authorize', token, request())).data.decision, 'BLOCK');
});
test('governed agent cannot modify envelope, register identities, approve or revoke', async t => {
  const { call, token, store } = await setup(t);
  for (const [path, input] of [
    ['/v1/envelopes', envelope()], ['/v1/agents/register', { id: 'attacker', name: 'Attacker' }],
    ['/v1/approvals', { request: request(), expiresAt: '2026-09-08T12:01:00Z' }],
    ['/v1/revoke', { agentId: request().agentId, reason: 'Attack' }],
  ] as const) assert.equal((await call(path, token, input)).status, 403);
  assert.equal((await call('/v1/authorize', token, request())).data.decision, 'HOLD');
  assert(store.events().filter(e => (e as { type: string }).type === 'http.rejected').length >= 4);
});
test('agent identity and decision reads are isolated', async t => {
  const { call, token } = await setup(t);
  const other = await call('/v1/agents/register', admin, { id: 'other-agent', name: 'Other' });
  const otherToken = String(other.data.token);
  assert.equal((await call('/v1/authorize', otherToken, request())).status, 403);
  const d = await call('/v1/authorize', token, request());
  assert.equal((await call(`/v1/decisions/${String(d.data.decisionId)}`, otherToken)).status, 403);
  assert.equal((await call(`/v1/envelopes/${request().agentId}`, otherToken)).status, 403);
  assert.equal((await call(`/v1/agents/${request().agentId}/activity`, otherToken)).status, 403);
});
test('approval roles cannot be forged or replaced by administrator', async t => {
  const { call } = await setup(t);
  const input = { request: request(), expiresAt: '2026-09-08T12:01:00Z' };
  assert.equal((await call('/v1/approvals', security, input)).status, 403);
  assert.equal((await call('/v1/approvals', admin, input)).status, 403);
  assert.equal((await call('/v1/approvals', release, { ...input, role: 'human-release-manager' })).status, 400);
});
test('approval is single-use even under concurrent requests', async t => {
  const { call, token, approve } = await setup(t);
  const approvalId = await approve();
  const results = await Promise.all(Array.from({ length: 8 }, () => call('/v1/authorize', token, { ...request(), approvalId })));
  assert.equal(results.filter(r => r.data.decision === 'ALLOW').length, 1);
  assert.equal(results.filter(r => r.data.decision === 'HOLD').length, 7);
});
test('approval binds exact resource, cost, destination and envelope issuance', async t => {
  const { call, token, approve } = await setup(t);
  const approvalId = await approve();
  assert.equal((await call('/v1/authorize', token, { ...request(), estimatedCostUsd: 0.13, approvalId })).data.decision, 'HOLD');
  assert.equal((await call('/v1/authorize', token, { ...request(), destination: 'health.internal.company', approvalId })).data.decision, 'HOLD');
  // Republishing identical content must not resurrect an approval from an earlier issuance.
  await call('/v1/envelopes', admin, envelope());
  assert.equal((await call('/v1/authorize', token, { ...request(), approvalId })).data.decision, 'HOLD');
});
test('expired approvals hold and expired envelopes block', async t => {
  const { call, token, approve, setTime } = await setup(t);
  const approvalId = await approve();
  setTime(NOW + 60_000);
  assert.equal((await call('/v1/authorize', token, { ...request(), approvalId })).data.decision, 'HOLD');
  setTime(Date.parse(envelope().agent.expires_at));
  assert.equal((await call('/v1/authorize', token, { ...request(), approvalId })).data.decision, 'BLOCK');
});
test('concurrent spending cannot exceed budget; policy replacement preserves counters', async t => {
  const { call, token } = await setup(t);
  const e = envelope(); e.approvals.required_for = []; e.limits.max_cost_usd = 0.12;
  await call('/v1/envelopes', admin, e);
  const results = await Promise.all(Array.from({ length: 8 }, () => call('/v1/authorize', token, request())));
  assert.equal(results.filter(r => r.data.decision === 'ALLOW').length, 1);
  await call('/v1/envelopes', admin, e);
  assert.equal((await call('/v1/authorize', token, request())).data.decision, 'HOLD');
});
test('malformed requests, unknown fields and missing credentials fail closed', async t => {
  const { call, token, base } = await setup(t);
  assert.equal((await fetch(base + '/v1/authorize', { method: 'POST' })).status, 401);
  assert.equal((await call('/v1/authorize', 'invalid', request())).status, 401);
  assert.equal((await call('/v1/authorize', token, { ...request(), approved: true })).status, 400);
  assert.equal((await call('/v1/authorize', token, { ...request(), estimatedCostUsd: -1 })).status, 400);
  assert.equal((await fetch(base + '/v1/authorize', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/v1/authorize', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});
test('credential separation rejects short and duplicate credentials', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => createGateServer(new Gate(store), { adminToken: 'short', approvers: [] }));
    assert.throws(() => createGateServer(new Gate(store), { adminToken: admin, approvers: [{ token: admin, role: 'security' }] }));
  } finally { store.close(); }
});

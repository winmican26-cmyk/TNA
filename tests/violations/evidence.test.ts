import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../packages/evidence-core/src/index.js';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { envelope, request, NOW } from '../fixture.js';
const admin = { kind: 'admin', role: 'administrator' } as const;
const agent = { kind: 'agent', agentId: request().agentId } as const;
test('every ALLOW/BLOCK/HOLD persists complete decision evidence', () => {
  const store = new Store(':memory:');
  try {
    const gate = new Gate(store, () => NOW);
    gate.register(admin, { id: agent.agentId, name: 'Deploy' }); gate.setEnvelope(admin, envelope());
    gate.authorize(agent, request());
    gate.authorize(agent, { ...request(), tool: 'shell.unrestricted' });
    const e = envelope(); e.approvals.required_for = []; gate.setEnvelope(admin, e);
    gate.authorize(agent, request());
    const decisions = gate.activity(admin, agent.agentId);
    assert.deepEqual(decisions.map(d => d.decision).sort(), ['ALLOW', 'BLOCK', 'HOLD']);
    for (const d of decisions) { assert(d.policyHash); assert(d.timestamp); assert(d.request.action); assert(d.reason); assert(d.decisionId); }
    assert.equal(store.events().filter(e => (e as { type: string }).type === 'authorization.decision').length, 3);
    store.verifyEvidence();
  } finally { store.close(); }
});
test('evidence write failure rolls back decision and budget reservations', () => {
  const store = new Store(':memory:');
  try {
    const gate = new Gate(store, () => NOW);
    gate.register(admin, { id: agent.agentId, name: 'Deploy' });
    const e = envelope(); e.approvals.required_for = []; gate.setEnvelope(admin, e);
    store.append = () => { throw new Error('Disk unavailable'); };
    assert.throws(() => gate.authorize(agent, request()), /Disk unavailable/);
    assert.equal(gate.activity(admin, agent.agentId).length, 0);
    assert.equal(store.get('usage', agent.agentId), null);
  } finally { store.close(); }
});
test('state, revocation and evidence persist across restart; tampering is detected', () => {
  const parent = resolve('data', 'test'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(resolve(parent, 'evidence-')); const path = resolve(dir, 'test.sqlite');
  try {
    const first = new Store(path); const gate = new Gate(first, () => NOW);
    gate.register(admin, { id: agent.agentId, name: 'Deploy' }); gate.setEnvelope(admin, envelope());
    const d = gate.authorize(agent, request()); gate.revoke(admin, { agentId: agent.agentId, reason: 'Done' }); first.close();
    const second = new Store(path); const restored = new Gate(second, () => NOW);
    assert.equal(restored.decision(admin, d.decisionId).decision, 'HOLD');
    assert.equal(restored.authorize(agent, request()).reason, 'Agent has been revoked'); second.close();
    const raw = new DatabaseSync(path); raw.exec("UPDATE evidence SET body='{}' WHERE seq=1"); raw.close();
    assert.throws(() => new Store(path), /integrity/);
  } finally {
    // Only this test-created directory, proven within the workspace test root, is removed.
    assert(dir.startsWith(parent + '\\') || dir.startsWith(parent + '/'));
    rmSync(dir, { recursive: true, force: true });
  }
});

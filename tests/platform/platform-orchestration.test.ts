import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { Ledger, LedgerStore, readerPrincipal, writerPrincipal } from '../../packages/ledger-core/src/index.js';
import { agentPrincipal } from '../../packages/platform-schema/src/index.js';
import { PlatformGateOrchestrator, PlatformLedgerDispatcher, PlatformStore } from '../../packages/platform-core/src/index.js';
import { NOW, envelope } from '../fixture.js';

const ADMIN = { kind: 'admin', role: 'administrator' } as const;
const TENANT = 'tenant_demo';
const AGENT = 'deployment-agent-17';
const request = (requestId: string, patch: Record<string, unknown> = {}) => ({
  version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
  action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/deploy.log',
  input: { message: 'ok' }, requires_verification: false, ...patch,
});

function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-orchestration-'));
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
  const evidence = new Store(':memory:');
  const gate = new Gate(evidence, () => NOW);
  gate.register(ADMIN, { id: AGENT, name: 'Deployment Agent' });
  gate.setEnvelope(ADMIN, envelope());
  const ledger = new Ledger(new LedgerStore(':memory:'));
  const writer = writerPrincipal('platform-ledger-writer', TENANT, ['platform']);
  const reader = readerPrincipal('platform-ledger-reader', TENANT);
  return { dir, platform, evidence, gate, ledger, writer, reader };
}
function close(f: ReturnType<typeof fixture>) { f.platform.close(); f.evidence.close(); f.ledger.close(); rmSync(f.dir, { recursive: true, force: true }); }

test('real Gate ALLOW records durable exact decision and does not execute', () => {
  const f = fixture(); try {
    const action = f.platform.createOrReturn(request('allow_1'), 'platform-service');
    const result = new PlatformGateOrchestrator(f.platform, f.gate).authorize(agentPrincipal('p-agent', TENANT, AGENT), action.platform_action_id);
    assert.equal(result.state, 'AUTHORIZED');
    assert.equal(result.gate_decision?.decision, 'ALLOW');
    assert.equal(result.gate_decision?.decision_id.startsWith('dec_'), true);
    assert.equal(f.platform.listOutbox(TENANT, action.platform_action_id).some(x => x.event_type === 'PLATFORM_EXECUTION_CLAIMED'), false);
  } finally { close(f); }
});

test('real Gate BLOCK and HOLD become terminal/pre-execution states with no execution claim', () => {
  const f = fixture(); try {
    const runtime = new PlatformGateOrchestrator(f.platform, f.gate);
    const blocked = f.platform.createOrReturn(request('block_1', { tool: 'shell.unrestricted' }), 'platform-service');
    assert.equal(runtime.authorize(agentPrincipal('p-agent', TENANT, AGENT), blocked.platform_action_id).state, 'BLOCKED');
    const held = f.platform.createOrReturn(request('hold_1', {
      action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' },
    }), 'platform-service');
    assert.equal(runtime.authorize(agentPrincipal('p-agent', TENANT, AGENT), held.platform_action_id).state, 'HELD');
    for (const action of [blocked, held]) assert.equal(f.platform.listOutbox(TENANT, action.platform_action_id).some(x => x.event_type === 'PLATFORM_EXECUTION_CLAIMED'), false);
  } finally { close(f); }
});

test('Ledger dispatch is deterministic, idempotent, and reconstructs a real per-event causal chain by platform correlation', async () => {
  // Distributed-evidence closure, Finding 2: causation_id chains each event to the *immediately
  // preceding event this specific action enqueued* (captured once, at enqueue time), never to
  // whatever the action's Gate decision currently happens to be — see
  // docs/platform/platform-v0.1-distributed-evidence-closure.md and platform-causation.test.ts for
  // the dedicated drift regression. This test only proves the chain is genuinely wired end to end
  // through a real Ledger append.
  const f = fixture(); try {
    const action = f.platform.createOrReturn(request('ledger_1'), 'platform-service');
    const authorized = new PlatformGateOrchestrator(f.platform, f.gate).authorize(agentPrincipal('p-agent', TENANT, AGENT), action.platform_action_id);
    const dispatcher = new PlatformLedgerDispatcher(f.platform, { append: input => f.ledger.append(f.writer, input) }, { clock: () => NOW });
    const first = await dispatcher.dispatchOnce();
    assert.equal(first.delivered, 3);
    assert.deepEqual(await dispatcher.dispatchOnce(), { delivered: 0, failed: 0, deadLettered: 0 });
    const events = f.ledger.getEventsByCorrelation(f.reader, authorized.correlation_id).items.sort((a, b) => a.sequence - b.sequence);
    assert.equal(events.length, 3);
    // Root event: no prior cause.
    assert.equal(events[0]?.causation_id, undefined);
    // Each later event's causation_id is exactly the previous event's own id — a real causal chain,
    // not a flat "everything points at the current decision" structure.
    assert.equal(events[1]?.causation_id, events[0]?.event_id);
    assert.equal(events[2]?.causation_id, events[1]?.event_id);
    const decision = events.find(event => event.event_type === 'PLATFORM_ACTION_AUTHORIZED');
    // The decision id itself is still recorded — via authority_context, captured from this record's
    // own payload snapshot, not derived from current action state at dispatch time.
    assert.equal(decision?.authority_context?.decision_id, authorized.gate_decision?.decision_id);
    assert.equal((decision?.payload?.gate_decision as { decision: string }).decision, 'ALLOW');
    assert.equal(events.every(event => event.correlation_id === authorized.correlation_id), true);
  } finally { close(f); }
});

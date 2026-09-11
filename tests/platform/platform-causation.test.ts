import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../../packages/execution-broker/src/index.js';
import { Ledger, LedgerStore, readerPrincipal, writerPrincipal } from '../../packages/ledger-core/src/index.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory } from '../../packages/sentinel-runtime/src/index.js';
import { agentPrincipal, operatorPrincipal } from '../../packages/platform-schema/src/index.js';
import {
  PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformControlOrchestrator, PlatformFacade,
  PlatformLedgerDispatcher, PlatformStore, reconstructPlatformAction, type SentinelPort, type VadPort,
} from '../../packages/platform-core/src/index.js';
import { NOW, envelope } from '../fixture.js';

const TENANT = 'tenant_demo';
const AGENT = 'deployment-agent-17';
const ADMIN = { kind: 'admin', role: 'administrator' } as const;

function fixture(sentinelPort?: SentinelPort, vad?: VadPort) {
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-causation-'));
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
  const evidence = new Store(':memory:');
  const gate = new Gate(evidence, () => NOW);
  gate.register(ADMIN, { id: AGENT, name: 'Deployment Agent' });
  gate.setEnvelope(ADMIN, envelope());
  const registry = new ToolRegistry();
  registry.register({ name: 'log.write', action: 'log.write', resourceType: 'files', allowedOperations: ['read'], networkRequired: false, credentialsRequired: [], handler: () => ({ ok: true }) });
  const broker = new ExecutionBroker(evidence, new CapabilityCodec(randomBytes(32)), registry);
  const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
  const port: SentinelPort = sentinelPort ?? sentinel;
  const ledgerStore = new LedgerStore(':memory:');
  const ledger = new Ledger(ledgerStore);
  const writer = writerPrincipal('platform-ledger-writer', TENANT, ['platform']);
  const reader = readerPrincipal('platform-ledger-reader', TENANT);
  const gateOrchestrator = new PlatformGateOrchestrator(platform, gate);
  const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, port, sentinelController('c', TENANT), sentinelObserverFactory('o', TENANT, ['EXECUTION_BROKER']), vad);
  const control = new PlatformControlOrchestrator(platform);
  const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
  const dispatcher = new PlatformLedgerDispatcher(platform, { append: input => ledger.append(writer, input) }, { clock: () => NOW });
  return { dir, platform, evidence, gate, sentinel, ledgerStore, ledger, writer, reader, gateOrchestrator, executionOrchestrator, control, facade, dispatcher };
}
function close(f: ReturnType<typeof fixture>) { f.platform.close(); f.evidence.close(); f.sentinel.close(); f.ledgerStore.close(); rmSync(f.dir, { recursive: true, force: true }); }
const request = (requestId: string, patch: Record<string, unknown> = {}) => ({
  version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
  action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/deploy.log',
  input: { message: 'ok' }, requires_verification: false, ...patch,
});
const holdRequest = (requestId: string) => ({
  version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
  action: 'production.deploy', tool: 'deploy.execute', operation: 'write', resource: 'prod.deploy.release',
  metadata: { destination: 'deploy.internal.company' }, input: {}, requires_verification: false,
});

test('historical causation must not drift: an earlier record dispatched after the action\'s current decision has since changed still shows the decision that actually caused it', async () => {
  const f = fixture(); try {
    const action = f.platform.createOrReturn(holdRequest('drift_1'), 'platform-service');
    const held = f.gateOrchestrator.authorize(agentPrincipal('p', TENANT, AGENT), action.platform_action_id);
    assert.equal(held.state, 'HELD');
    const firstDecisionId = held.gate_decision?.decision_id;
    assert.ok(firstDecisionId);

    // Do NOT dispatch yet. Progress the action further first: resume -> re-authorize. Gate issues a
    // brand-new decision_id on every call (even for the identical HOLD outcome again, since no
    // approval was ever supplied — the platform adds no approval-injection mechanism, which would be
    // a new feature), so the action's *current* gate_decision is now a different id than the one that
    // actually caused the HELD record enqueued above.
    f.control.resume(operatorPrincipal('op', TENANT), action.platform_action_id);
    const heldAgain = f.gateOrchestrator.authorize(agentPrincipal('p', TENANT, AGENT), action.platform_action_id);
    const secondDecisionId = heldAgain.gate_decision?.decision_id;
    assert.ok(secondDecisionId);
    assert.notEqual(firstDecisionId, secondDecisionId, 'test setup sanity: the two decisions must genuinely differ');

    // Only now dispatch everything queued so far — including the original HELD record, whose payload
    // was captured back when the current decision really was the first one.
    const summary = await f.dispatcher.dispatchOnce();
    assert.equal(summary.failed, 0);

    const events = f.ledger.getEventsByCorrelation(f.reader, action.correlation_id).items;
    const firstHeld = events.find(e => e.event_type === 'PLATFORM_ACTION_HELD');
    assert.ok(firstHeld);
    assert.equal(firstHeld.authority_context?.decision_id, firstDecisionId, 'the earlier HELD record must retain the decision that actually caused it, not the action\'s later current decision');
    assert.notEqual(firstHeld.authority_context?.decision_id, secondDecisionId);
  } finally { close(f); }
});

test('BLOCK causal chain: no fabricated capability, Sentinel, or execution causation', async () => {
  const f = fixture(); try {
    const action = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), request('block_chain', { tool: 'shell.unrestricted' }), 'platform-service');
    assert.equal(action.state, 'BLOCKED');
    const reconstruction = reconstructPlatformAction(f.platform, TENANT, action.platform_action_id);
    assert.ok(reconstruction.causal_chain.length >= 2);
    for (const step of reconstruction.causal_chain) {
      assert.equal(step.capability_id, undefined, 'a BLOCKed action must never show a fabricated capability in its causal chain');
      assert.equal(step.sentinel_session_id, undefined);
      assert.equal(step.execution_id, undefined);
      assert.equal(step.vad_atom_id, undefined);
    }
    // Chain integrity: every non-root step's caused_by matches the immediately preceding step's own event_id.
    for (let i = 1; i < reconstruction.causal_chain.length; i += 1) assert.equal(reconstruction.causal_chain[i]?.caused_by, reconstruction.causal_chain[i - 1]?.event_id);
    assert.equal(reconstruction.causal_chain[0]?.caused_by, null);
  } finally { close(f); }
});

test('ALLOW -> capability -> Sentinel -> execution causal chain is correct end to end', async () => {
  const f = fixture(); try {
    const action = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), request('allow_chain'), 'platform-service');
    assert.equal(action.state, 'COMPLETED');
    const reconstruction = reconstructPlatformAction(f.platform, TENANT, action.platform_action_id);
    const executionStep = reconstruction.causal_chain.find(step => step.event_type === 'PLATFORM_EXECUTION_CLAIMED');
    assert.ok(executionStep);
    assert.equal(executionStep.capability_id, action.capability_id);
    assert.equal(executionStep.sentinel_session_id, action.sentinel_session_id);
    assert.ok(executionStep.decision_id);
    for (let i = 1; i < reconstruction.causal_chain.length; i += 1) assert.equal(reconstruction.causal_chain[i]?.caused_by, reconstruction.causal_chain[i - 1]?.event_id);
    // Real Ledger delivery round-trip of the same chain.
    await f.dispatcher.dispatchOnce();
    const events = f.ledger.getEventsByCorrelation(f.reader, action.correlation_id).items.sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < events.length; i += 1) assert.equal(events[i]?.causation_id, events[i - 1]?.event_id);
  } finally { close(f); }
});

test('VAD causal chain: the verification step captures its own vad_atom_id, chained from the execution step', async () => {
  const vad: VadPort = { verify: async () => ({ atom_id: 'atom_causal_1', final_state: 'ACCEPTED' }) };
  const f = fixture(undefined, vad); try {
    const action = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), request('vad_chain', { requires_verification: true }), 'platform-service');
    assert.equal(action.state, 'COMPLETED');
    const reconstruction = reconstructPlatformAction(f.platform, TENANT, action.platform_action_id);
    const verificationStep = reconstruction.causal_chain.find(step => step.vad_atom_id === 'atom_causal_1');
    assert.ok(verificationStep);
    const executionStep = reconstruction.causal_chain.find(step => step.event_type === 'PLATFORM_EXECUTION_CLAIMED');
    assert.ok(executionStep);
    // The verification step must eventually trace back to the execution step (may be directly
    // adjacent or one hop further depending on the VERIFYING-entry event in between).
    let cursor: string | null = verificationStep.caused_by;
    const seen = new Set<string>();
    let reachedExecution = false;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (cursor === executionStep.event_id) { reachedExecution = true; break; }
      const next = reconstruction.causal_chain.find(step => step.event_id === cursor);
      cursor = next?.caused_by ?? null;
    }
    assert.ok(reachedExecution, 'the VAD verification step must transitively chain back to the execution it verified');
  } finally { close(f); }
});

test('termination causal chain: a Sentinel-terminated action chains its terminal record back to the execution claim, with no fabricated execution/VAD outcome', async () => {
  const fakeSentinel: SentinelPort = {
    createSession: () => ({ sentinel_session_id: 'sess_causal', status: 'MONITORING' } as never),
    getSession: () => ({ status: 'TERMINATED' } as never),
    submitObservation: async () => ({ observation: {} as never, decision: { decision: 'TERMINATE', violations: [] } as never }),
    completeSession: () => ({ status: 'COMPLETED' } as never),
  };
  const f = fixture(fakeSentinel); try {
    const action = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), request('terminate_chain'), 'platform-service');
    assert.equal(action.state, 'TERMINATED');
    const reconstruction = reconstructPlatformAction(f.platform, TENANT, action.platform_action_id);
    const terminatedStep = reconstruction.causal_chain.find(step => step.event_type === 'PLATFORM_ACTION_TERMINATED');
    assert.ok(terminatedStep);
    const executionStep = reconstruction.causal_chain.find(step => step.event_type === 'PLATFORM_EXECUTION_CLAIMED');
    assert.ok(executionStep);
    assert.equal(terminatedStep.caused_by, executionStep.event_id);
    assert.equal(terminatedStep.execution_id, undefined, 'a terminated-before-execution action must never show a fabricated execution result');
    assert.equal(terminatedStep.vad_atom_id, undefined);
  } finally { close(f); }
});

test('cross-action evidence cannot enter another action\'s reconstruction, even within the same tenant', async () => {
  const f = fixture(); try {
    const actionA = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), request('splice_a'), 'platform-service');
    const actionB = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), request('splice_b'), 'platform-service');
    const outboxA = f.platform.listOutbox(TENANT, actionA.platform_action_id);
    const outboxB = f.platform.listOutbox(TENANT, actionB.platform_action_id);
    const idsA = new Set(outboxA.map(o => o.outbox_id));
    assert.ok(outboxB.every(o => !idsA.has(o.outbox_id)));
    assert.ok(outboxA.every(o => o.platform_action_id === actionA.platform_action_id));
    const reconstructionA = reconstructPlatformAction(f.platform, TENANT, actionA.platform_action_id);
    assert.equal(reconstructionA.causal_chain.length, outboxA.length);
  } finally { close(f); }
});

test('cross-tenant causal-chain splicing is blocked even with a colliding correlation_id', async () => {
  const f = fixture(); try {
    const tenant2 = 'tenant_other';
    const actionA = f.platform.createOrReturn(request('cross_tenant_a'), 'platform-service');
    const actionB = f.platform.createOrReturn({ ...request('cross_tenant_b'), tenant_id: tenant2 }, 'platform-service');
    // White-box: force a colliding correlation_id across tenants — something no legitimate code path
    // can produce (correlation ids are runtime-generated UUIDs) — to prove tenant scoping is real SQL
    // scoping, not merely "never observed to collide in practice".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb = (f.platform as any).db as { prepare(sql: string): { run(...args: unknown[]): unknown } };
    rawDb.prepare('UPDATE platform_actions SET correlation_id=? WHERE tenant_id=? AND platform_action_id=?').run(actionA.correlation_id, tenant2, actionB.platform_action_id);

    const writerT2 = writerPrincipal('t2-writer', tenant2, ['platform']);
    const readerT2 = readerPrincipal('t2-reader', tenant2);
    const dispatcherA = f.dispatcher;
    const dispatcherB = new PlatformLedgerDispatcher(f.platform, { append: input => f.ledger.append(writerT2, input) }, { clock: () => NOW });
    await dispatcherA.dispatchOnce();
    await dispatcherB.dispatchOnce();

    const eventsForTenant1 = f.ledger.getEventsByCorrelation(f.reader, actionA.correlation_id).items;
    const eventsForTenant2 = f.ledger.getEventsByCorrelation(readerT2, actionA.correlation_id).items;
    assert.ok(eventsForTenant1.every(e => e.tenant_id === TENANT), 'tenant 1\'s correlation query must never surface tenant 2\'s events, even with a colliding correlation_id');
    assert.ok(eventsForTenant2.every(e => e.tenant_id === tenant2));
    assert.equal(eventsForTenant1.length, f.platform.listOutbox(TENANT, actionA.platform_action_id).length);

    const reconstructionA = reconstructPlatformAction(f.platform, TENANT, actionA.platform_action_id);
    const reconstructionB = reconstructPlatformAction(f.platform, tenant2, actionB.platform_action_id);
    assert.equal(reconstructionA.causal_chain.length, f.platform.listOutbox(TENANT, actionA.platform_action_id).length);
    assert.equal(reconstructionB.causal_chain.length, f.platform.listOutbox(tenant2, actionB.platform_action_id).length);
  } finally { close(f); }
});

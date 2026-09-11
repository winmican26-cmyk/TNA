import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry, type ToolHandlerContext } from '../../packages/execution-broker/src/index.js';
import { Ledger, LedgerStore, readerPrincipal, writerPrincipal } from '../../packages/ledger-core/src/index.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory } from '../../packages/sentinel-runtime/src/index.js';
import { agentPrincipal, PlatformError } from '../../packages/platform-schema/src/index.js';
import {
  PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformLedgerDispatcher, PlatformStore,
  type SentinelPort, type VadPort,
} from '../../packages/platform-core/src/index.js';
import { NOW, envelope } from '../fixture.js';

const ADMIN = { kind: 'admin', role: 'administrator' } as const;
const TENANT = 'tenant_demo';
const AGENT = 'deployment-agent-17';
const request = (requestId: string, patch: Record<string, unknown> = {}) => ({
  version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
  action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/deploy.log',
  input: { message: 'ok' }, requires_verification: false, ...patch,
});

let connectorCalls: ToolHandlerContext[] = [];
function registry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'log.write', action: 'log.write', resourceType: 'files', allowedOperations: ['read'], networkRequired: false, credentialsRequired: [],
    handler: context => { connectorCalls.push(context); return { echoed: context.input }; },
  });
  return registry;
}

function fixture(sentinelPort?: SentinelPort) {
  connectorCalls = [];
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-execution-'));
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
  const evidence = new Store(':memory:');
  const gate = new Gate(evidence, () => NOW);
  gate.register(ADMIN, { id: AGENT, name: 'Deployment Agent' });
  gate.setEnvelope(ADMIN, envelope());
  const broker = new ExecutionBroker(evidence, new CapabilityCodec(randomBytes(32)), registry());
  const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
  const port: SentinelPort = sentinelPort ?? sentinel;
  const ledger = new Ledger(new LedgerStore(':memory:'));
  const writer = writerPrincipal('platform-ledger-writer', TENANT, ['platform']);
  const reader = readerPrincipal('platform-ledger-reader', TENANT);
  const orchestrator = new PlatformExecutionOrchestrator(platform, broker, port, sentinelController('platform-sentinel-controller', TENANT), sentinelObserverFactory('platform-execution-broker', TENANT, ['EXECUTION_BROKER']));
  return { dir, platform, evidence, gate, broker, sentinel, ledger, writer, reader, orchestrator };
}
function close(f: ReturnType<typeof fixture>) { f.platform.close(); f.evidence.close(); f.sentinel.close(); f.ledger.close(); rmSync(f.dir, { recursive: true, force: true }); }

async function authorizeAndReachAuthorized(f: ReturnType<typeof fixture>, requestId = 'exec_1', patch: Record<string, unknown> = {}) {
  const action = f.platform.createOrReturn(request(requestId, patch), 'platform-service');
  return new PlatformGateOrchestrator(f.platform, f.gate).authorize(agentPrincipal('p-agent', TENANT, AGENT), action.platform_action_id);
}

test('end-to-end: ALLOW -> capability -> Sentinel session -> broker-mediated execution -> COMPLETED, with reconstructable Ledger evidence', async () => {
  const f = fixture(); try {
    const authorized = await authorizeAndReachAuthorized(f);
    const outcome = await f.orchestrator.run(agentPrincipal('p-agent', TENANT, AGENT), authorized.platform_action_id);
    assert.equal(outcome.executed, true);
    assert.equal(outcome.action.state, 'COMPLETED');
    assert.ok(outcome.action.capability_id);
    assert.ok(outcome.action.sentinel_session_id);
    assert.ok(outcome.action.result_hash);
    assert.equal(connectorCalls.length, 1);
    // Documented integration constraint (platform-gate-integration-v0.1.md, "failing-first defect"):
    // ExecutionBroker's own internal ToolInputRegistry is private and pre-registers exactly one tool
    // (`demo.deploy.execute`) — for every other tool, including this platform's own connectors, the
    // broker hands the handler an empty `input: {}` regardless of what was redeemed with. The real
    // request content is never lost, though: it is the platform's own persisted `request.input`
    // (bound via `input_hash` independently of the broker, section 19) and Ledger evidence trail that
    // remain authoritative — not the broker's own handler context, which this proves does not carry it.
    assert.deepEqual(connectorCalls[0]?.input, {});
    assert.deepEqual(outcome.action.request.input, { message: 'ok' });

    const dispatcher = new PlatformLedgerDispatcher(f.platform, { append: input => f.ledger.append(f.writer, input) }, { clock: () => NOW });
    const summary = await dispatcher.dispatchOnce();
    assert.equal(summary.failed, 0); assert.equal(summary.deadLettered, 0); assert.ok(summary.delivered >= 3);
    const events = f.ledger.getEventsByCorrelation(f.reader, authorized.correlation_id).items;
    assert.ok(events.some(e => e.event_type === 'PLATFORM_ACTION_AUTHORIZED'));
    assert.ok(events.some(e => e.event_type === 'PLATFORM_EXECUTION_STARTED'));
    assert.ok(events.some(e => e.event_type === 'PLATFORM_ACTION_COMPLETED'));
    assert.equal(events.every(e => e.correlation_id === authorized.correlation_id), true);
  } finally { close(f); }
});

test('a non-agent principal cannot drive execution, and an agent bound to a different agent_id cannot either', async () => {
  const f = fixture(); try {
    const authorized = await authorizeAndReachAuthorized(f, 'exec_forbidden');
    await assert.rejects(() => f.orchestrator.run({ id: 'op', role: 'platform-operator', tenantId: TENANT }, authorized.platform_action_id), (e: unknown) => e instanceof PlatformError && e.code === 'FORBIDDEN');
    await assert.rejects(() => f.orchestrator.run(agentPrincipal('p-agent', TENANT, 'someone-else'), authorized.platform_action_id), (e: unknown) => e instanceof PlatformError && e.code === 'FORBIDDEN');
    assert.equal(connectorCalls.length, 0);
  } finally { close(f); }
});

test('Sentinel pre-action TERMINATE (confirmed) prevents connector invocation and resolves the action to TERMINATED', async () => {
  const fakeSentinel: SentinelPort = {
    createSession: () => ({ sentinel_session_id: 'sess_fake', status: 'MONITORING' } as never),
    getSession: () => ({ status: 'TERMINATED' } as never),
    submitObservation: async () => ({ observation: {} as never, decision: { decision: 'TERMINATE', violations: [{ rule_type: 'TOOL_NOT_ALLOWED' }] } as never }),
    completeSession: () => ({ status: 'COMPLETED' } as never),
  };
  const f = fixture(fakeSentinel); try {
    const authorized = await authorizeAndReachAuthorized(f, 'exec_terminate');
    const outcome = await f.orchestrator.run(agentPrincipal('p-agent', TENANT, AGENT), authorized.platform_action_id);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.action.state, 'TERMINATED');
    assert.equal(outcome.action.error_code, 'SENTINEL_TERMINATED');
    assert.equal(connectorCalls.length, 0);
  } finally { close(f); }
});

test('Sentinel pre-action TERMINATE whose containment is not yet confirmed resolves to INDETERMINATE, never a false TERMINATED', async () => {
  const fakeSentinel: SentinelPort = {
    createSession: () => ({ sentinel_session_id: 'sess_fake', status: 'MONITORING' } as never),
    getSession: () => ({ status: 'TERMINATING' } as never),
    submitObservation: async () => ({ observation: {} as never, decision: { decision: 'TERMINATE', violations: [] } as never }),
    completeSession: () => ({ status: 'COMPLETED' } as never),
  };
  const f = fixture(fakeSentinel); try {
    const authorized = await authorizeAndReachAuthorized(f, 'exec_indeterminate_term');
    const outcome = await f.orchestrator.run(agentPrincipal('p-agent', TENANT, AGENT), authorized.platform_action_id);
    assert.equal(outcome.action.state, 'INDETERMINATE');
    assert.equal(connectorCalls.length, 0);
  } finally { close(f); }
});

test('Sentinel pre-action HOLD prevents connector invocation and resolves the action to INDETERMINATE with SENTINEL_HOLD', async () => {
  const fakeSentinel: SentinelPort = {
    createSession: () => ({ sentinel_session_id: 'sess_fake', status: 'MONITORING' } as never),
    getSession: () => ({ status: 'HELD' } as never),
    submitObservation: async () => ({ observation: {} as never, decision: { decision: 'HOLD', violations: [] } as never }),
    completeSession: () => ({ status: 'COMPLETED' } as never),
  };
  const f = fixture(fakeSentinel); try {
    const authorized = await authorizeAndReachAuthorized(f, 'exec_hold');
    const outcome = await f.orchestrator.run(agentPrincipal('p-agent', TENANT, AGENT), authorized.platform_action_id);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.action.state, 'INDETERMINATE');
    assert.equal(outcome.action.error_code, 'SENTINEL_HOLD');
    assert.equal(connectorCalls.length, 0);
  } finally { close(f); }
});

test('a Sentinel session that cannot be created at all fails closed to INDETERMINATE — never falls back to unmonitored execution', async () => {
  const fakeSentinel: SentinelPort = {
    createSession: () => { throw new Error('Sentinel store unavailable'); },
    getSession: () => { throw new Error('unreachable'); },
    submitObservation: async () => { throw new Error('unreachable'); },
    completeSession: () => { throw new Error('unreachable'); },
  };
  const f = fixture(fakeSentinel); try {
    const authorized = await authorizeAndReachAuthorized(f, 'exec_sentinel_unavailable');
    await assert.rejects(() => f.orchestrator.run(agentPrincipal('p-agent', TENANT, AGENT), authorized.platform_action_id));
    assert.equal(f.platform.get(TENANT, authorized.platform_action_id).state, 'INDETERMINATE');
    assert.equal(connectorCalls.length, 0);
  } finally { close(f); }
});

test('input-binding drift between authorization and execution blocks the connector (section 19) — white-box: corrupts the stored request directly', async () => {
  const f = fixture(); try {
    const authorized = await authorizeAndReachAuthorized(f, 'exec_drift');
    const raw = (f.platform as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    const tampered = { ...request('exec_drift'), input: { message: 'TAMPERED AFTER AUTHORIZATION' } };
    raw.prepare('UPDATE platform_actions SET request_json = ? WHERE tenant_id = ? AND platform_action_id = ?').run(JSON.stringify(tampered), TENANT, authorized.platform_action_id);
    const outcome = await f.orchestrator.run(agentPrincipal('p-agent', TENANT, AGENT), authorized.platform_action_id);
    assert.equal(outcome.executed, false);
    assert.equal(outcome.action.state, 'TERMINATED');
    assert.equal(outcome.action.error_code, 'EXECUTION_FAILED');
    assert.equal(connectorCalls.length, 0);
  } finally { close(f); }
});

test('VAD required: ACCEPTED completes the action, REJECTED fails it, ESCALATED leaves it INDETERMINATE — never a silent skip', async () => {
  for (const [finalState, expectState, expectErrorCode] of [['ACCEPTED', 'COMPLETED', null], ['REJECTED', 'FAILED', 'VERIFICATION_REJECTED'], ['ESCALATED', 'INDETERMINATE', 'VERIFICATION_ESCALATED']] as const) {
    const vad: VadPort = { verify: async () => ({ atom_id: `atom_${finalState}`, final_state: finalState }) };
    const dir = mkdtempSync(resolve(tmpdir(), 'platform-execution-vad-'));
    const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
    const evidence = new Store(':memory:');
    const gate = new Gate(evidence, () => NOW);
    gate.register(ADMIN, { id: AGENT, name: 'Deployment Agent' });
    gate.setEnvelope(ADMIN, envelope());
    const broker = new ExecutionBroker(evidence, new CapabilityCodec(randomBytes(32)), registry());
    const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
    sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
    const orchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController('c', TENANT), sentinelObserverFactory('o', TENANT, ['EXECUTION_BROKER']), vad);
    try {
      const action = platform.createOrReturn(request(`exec_vad_${finalState}`, { requires_verification: true }), 'platform-service');
      const authorized = new PlatformGateOrchestrator(platform, gate).authorize(agentPrincipal('p-agent', TENANT, AGENT), action.platform_action_id);
      const outcome = await orchestrator.run(agentPrincipal('p-agent', TENANT, AGENT), authorized.platform_action_id);
      assert.equal(outcome.action.state, expectState, `VAD ${finalState} should resolve to ${expectState}`);
      assert.equal(outcome.action.error_code, expectErrorCode);
      assert.equal(outcome.action.vad_final_state, finalState);
    } finally { platform.close(); evidence.close(); sentinel.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('VAD required but unconfigured resolves to INDETERMINATE, never a silent COMPLETED skip', async () => {
  const f = fixture(); try {
    const action = f.platform.createOrReturn(request('exec_vad_missing', { requires_verification: true }), 'platform-service');
    const authorized = new PlatformGateOrchestrator(f.platform, f.gate).authorize(agentPrincipal('p-agent', TENANT, AGENT), action.platform_action_id);
    const outcome = await f.orchestrator.run(agentPrincipal('p-agent', TENANT, AGENT), authorized.platform_action_id);
    assert.equal(outcome.action.state, 'INDETERMINATE');
    assert.equal(outcome.action.error_code, 'COMPONENT_UNAVAILABLE');
  } finally { close(f); }
});

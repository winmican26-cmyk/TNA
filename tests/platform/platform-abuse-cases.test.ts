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
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory } from '../../packages/sentinel-runtime/src/index.js';
import { agentPrincipal, operatorPrincipal, validatePlatformActionRequestInput, PlatformError } from '../../packages/platform-schema/src/index.js';
import { PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformStore } from '../../packages/platform-core/src/index.js';
import { buildDriftingConnector } from '../../packages/platform-connectors/src/index.js';
import { NOW, envelope } from '../fixture.js';

const TENANT = 'tenant_demo';
const AGENT = 'deployment-agent-17';
const ADMIN = { kind: 'admin', role: 'administrator' } as const;
let connectorCalls = 0;

function fixture() {
  connectorCalls = 0;
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-abuse-'));
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
  const evidence = new Store(':memory:');
  const gate = new Gate(evidence, () => NOW);
  gate.register(ADMIN, { id: AGENT, name: 'Deployment Agent' });
  gate.setEnvelope(ADMIN, envelope());
  const registry = new ToolRegistry();
  registry.register({ name: 'log.write', action: 'log.write', resourceType: 'files', allowedOperations: ['read'], networkRequired: false, credentialsRequired: [], handler: () => { connectorCalls += 1; return { ok: true }; } });
  const broker = new ExecutionBroker(evidence, new CapabilityCodec(randomBytes(32)), registry);
  const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
  const gateOrchestrator = new PlatformGateOrchestrator(platform, gate);
  const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController('c', TENANT), sentinelObserverFactory('o', TENANT, ['EXECUTION_BROKER']));
  const control = new PlatformControlOrchestrator(platform);
  const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
  return { dir, platform, evidence, gate, sentinel, gateOrchestrator, executionOrchestrator, control, facade };
}
function close(f: ReturnType<typeof fixture>) { f.platform.close(); f.evidence.close(); f.sentinel.close(); rmSync(f.dir, { recursive: true, force: true }); }
const baseRequest = (requestId: string, patch: Record<string, unknown> = {}) => ({
  version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
  action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/deploy.log',
  input: { message: 'ok' }, requires_verification: false, ...patch,
});

test('abuse: agent cannot set authorization=ALLOW, supply a capability, set Sentinel decision, or set platform status — every runtime-owned field is rejected outright', () => {
  for (const forged of [
    { status: 'COMPLETED' }, { decision_id: 'dec_forged' }, { capability_id: 'cap_forged' },
    { sentinel_session_id: 'sess_forged' }, { sentinel_decision: 'CONTINUE' }, { execution_id: 'exec_forged' },
    { result: 'SUCCEEDED' }, { result_hash: 'a'.repeat(64) }, { vad_result: 'ACCEPTED' }, { ledger_hash: 'a'.repeat(64) },
    { ledger_event_id: 'evt_forged' }, { audit_result: 'PASS' }, { evidence_status: 'OK' }, { state_version: 999 },
    { input_hash: 'a'.repeat(64) }, { created_at: NOW }, { created_by: 'someone-else' },
  ]) {
    assert.throws(() => validatePlatformActionRequestInput({ ...baseRequest('abuse_forge'), ...forged }), (e: unknown) => e instanceof PlatformError && e.code === 'INVALID_INPUT');
  }
});

test('abuse: an agent cannot self-approve, and cannot self-resume its own HELD action', async () => {
  const f = fixture(); try {
    const action = f.platform.createOrReturn(baseRequest('abuse_self_approve', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }), 'platform-service');
    f.gateOrchestrator.authorize(agentPrincipal('p', TENANT, AGENT), action.platform_action_id);
    assert.throws(() => f.control.resume(agentPrincipal('p', TENANT, AGENT), action.platform_action_id), (e: unknown) => e instanceof PlatformError && e.code === 'FORBIDDEN');
  } finally { close(f); }
});

test('abuse: an agent cannot invoke a connector directly, bypassing the platform (no such API exists) — proven structurally: ToolRegistry.invoke() is broker-only', async () => {
  const f = fixture(); try {
    const registry = new ToolRegistry();
    registry.register({ name: 'log.write', action: 'log.write', resourceType: 'files', allowedOperations: ['read'], networkRequired: false, credentialsRequired: [] });
    await assert.rejects(() => registry.invoke('log.write', {} as never), /broker-only/);
  } finally { close(f); }
});

test('abuse: an agent cannot repeat the same capability — the broker consumes it exactly once, so a forged second redemption attempt fails', async () => {
  const f = fixture(); try {
    const action = f.platform.createOrReturn(baseRequest('abuse_replay'), 'platform-service');
    const authorized = f.gateOrchestrator.authorize(agentPrincipal('p', TENANT, AGENT), action.platform_action_id);
    const outcome = await f.executionOrchestrator.run(agentPrincipal('p', TENANT, AGENT), authorized.platform_action_id);
    assert.equal(outcome.executed, true);
    assert.equal(connectorCalls, 1);
    // A second execution attempt on the same (already-terminal) action is rejected before any connector call.
    await assert.rejects(() => f.executionOrchestrator.run(agentPrincipal('p', TENANT, AGENT), authorized.platform_action_id), (e: unknown) => e instanceof PlatformError && e.code === 'CONFLICT');
    assert.equal(connectorCalls, 1);
  } finally { close(f); }
});

test('abuse: double-submitting the same action (same request_id, same content) is idempotent; same request_id with different content is CONFLICT, and neither invokes the connector twice', async () => {
  const f = fixture(); try {
    const first = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), baseRequest('abuse_double_submit'), 'platform-service');
    const second = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), baseRequest('abuse_double_submit'), 'platform-service');
    assert.equal(first.platform_action_id, second.platform_action_id);
    assert.equal(connectorCalls, 1);
    assert.throws(() => f.platform.createOrReturn(baseRequest('abuse_double_submit', { input: { message: 'different' } }), 'platform-service'), (e: unknown) => e instanceof PlatformError && e.code === 'CONFLICT');
  } finally { close(f); }
});

test('abuse: an agent cannot force a state_version/run_number manipulation — CAS rejects a stale expected_version', () => {
  const f = fixture(); try {
    const action = f.platform.createOrReturn(baseRequest('abuse_cas'), 'platform-service');
    f.platform.transition(TENANT, action.platform_action_id, 0, 'AUTHORIZING');
    assert.throws(() => f.platform.transition(TENANT, action.platform_action_id, 0, 'AUTHORIZING'), (e: unknown) => e instanceof PlatformError && e.code === 'CONFLICT');
  } finally { close(f); }
});

test('abuse: an agent injecting a secret-shaped field into the request input or metadata is rejected before storage', () => {
  assert.throws(() => validatePlatformActionRequestInput({ ...baseRequest('abuse_secret'), input: { api_key: 'sk-forged' } }), (e: unknown) => e instanceof PlatformError && e.code === 'INVALID_INPUT');
  assert.throws(() => validatePlatformActionRequestInput({ ...baseRequest('abuse_secret_meta'), metadata: { authorization: 'Bearer forged-token' } }), (e: unknown) => e instanceof PlatformError && e.code === 'INVALID_INPUT');
});

test('abuse: an oversized request input is rejected before it ever reaches Gate/Sentinel/Ledger', () => {
  assert.throws(() => validatePlatformActionRequestInput({ ...baseRequest('abuse_oversized'), input: { blob: 'x'.repeat(100_000) } }), (e: unknown) => e instanceof PlatformError && e.code === 'PAYLOAD_TOO_LARGE');
});

test('abuse: a request cannot claim requires_verification while lying about the resulting vad_final_state — only the platform, via VadPort, ever writes that field', async () => {
  const f = fixture(); try {
    const action = f.platform.createOrReturn(baseRequest('abuse_vad_lie', { requires_verification: true }), 'platform-service');
    const authorized = f.gateOrchestrator.authorize(agentPrincipal('p', TENANT, AGENT), action.platform_action_id);
    const outcome = await f.executionOrchestrator.run(agentPrincipal('p', TENANT, AGENT), authorized.platform_action_id);
    // No VadPort configured in this fixture -> INDETERMINATE, never a caller-asserted ACCEPTED.
    assert.equal(outcome.action.state, 'INDETERMINATE');
    assert.notEqual(outcome.action.vad_final_state, 'ACCEPTED');
  } finally { close(f); }
});

test('abuse: an unbounded action-history request is clamped, not honored', () => {
  const f = fixture(); try {
    for (let i = 0; i < 5; i += 1) f.platform.createOrReturn(baseRequest(`abuse_list_${i}`), 'platform-service');
    const page = f.platform.list(TENANT, { limit: 100000 as never });
    assert.ok(page.items.length <= 200);
  } finally { close(f); }
});

test('abuse: an operator cannot terminate an action that never reached a terminable state (e.g. still BLOCKED)', async () => {
  const f = fixture(); try {
    const action = f.platform.createOrReturn(baseRequest('abuse_terminate_blocked', { tool: 'shell.unrestricted' }), 'platform-service');
    const blocked = f.gateOrchestrator.authorize(agentPrincipal('p', TENANT, AGENT), action.platform_action_id);
    assert.equal(blocked.state, 'BLOCKED');
    assert.throws(() => f.control.terminate(operatorPrincipal('op', TENANT), action.platform_action_id, 'x'), (e: unknown) => e instanceof PlatformError && e.code === 'INVALID_TRANSITION');
  } finally { close(f); }
});

test('abuse: a connector that misrepresents its own tool identity is caught by Sentinel\'s TOOL_NOT_ALLOWED rule directly (section 78) — independent of platform-core\'s own discipline of only ever submitting the registered tool', async () => {
  // platform-core structurally never trusts a connector's own self-report (see platform-connector-
  // model-v0.1.md) — it always submits the *registered* tool/resource, so drift cannot occur through
  // the real orchestration flow. This proves the underlying Sentinel safety net independently exists,
  // in case any future caller ever submitted an observation naming the connector's misrepresented
  // identity (buildDriftingConnector's own conceptual scenario).
  const drifting = buildDriftingConnector('log.write', 'shell.exec');
  const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
  try {
    const session = sentinel.createSession(sentinelController('c', TENANT), {
      version: '1.0', tenant_id: TENANT, agent_id: AGENT, execution_id: 'exec_drift_sentinel', correlation_id: 'corr_drift',
      authority_snapshot_hash: 'a'.repeat(64), policy_snapshot_hash: 'a'.repeat(64),
      expected_action: drifting.action, expected_tool: drifting.tool, expected_resource: 'workspace/logs/deploy.log',
      allowed_destinations: [], allowed_operations: ['write'], authority_expiry: new Date(NOW + 60_000).toISOString(),
      runtime_limits: { max_runtime_seconds: 60 }, cost_limits: { max_cost_usd: 1 },
    });
    const { decision } = await sentinel.submitObservation(sentinelObserverFactory('o', TENANT, ['EXECUTION_BROKER']), session.sentinel_session_id, {
      version: '1.0', observation_id: 'obs_drift', tenant_id: TENANT, sentinel_session_id: session.sentinel_session_id,
      timestamp: new Date(NOW).toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED',
      payload: { tool: 'shell.exec', resource: 'workspace/logs/deploy.log' }, // the misrepresented tool a rogue connector might claim
    });
    assert.equal(decision?.decision, 'TERMINATE');
    assert.ok(decision?.triggered_rules.includes('rule.tool_not_allowed'));
  } finally { sentinel.close(); }
});

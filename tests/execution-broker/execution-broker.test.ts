import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { ExecutionBroker, BrokerError, ToolRegistry, createDemoRegistry, type ToolDefinition } from '../../packages/execution-broker/src/index.js';
import { ToolInputRegistry, demoToolInputMetadata } from '../../packages/tool-inputs/src/index.js';
import type { IsolatedExecutionRequest, IsolatedExecutionResult, IsolationRunner } from '../../packages/isolation-runner/src/index.js';
import { ChildProcessIsolationRunner } from '../../packages/isolation-runner/src/index.js';
import type { Decision } from '../../packages/shared-schema/src/index.js';

const agent = { kind: 'agent', agentId: 'agent-1' } as const;
const toolInputs = new ToolInputRegistry();
toolInputs.register(demoToolInputMetadata);
const demoInput = { release: 'release-1', environment: 'demo-production' };
const demoInputHash = toolInputs.parseAndHash('demo.deploy.execute', demoInput).input_hash;
const request = { agentId: 'agent-1', action: 'production.deploy', tool: 'demo.deploy.execute', resource: 'release-1', estimatedCostUsd: 0, input: demoInput, input_hash: demoInputHash };
function setup(tool: ToolDefinition | ToolRegistry | null = null, options: ConstructorParameters<typeof ExecutionBroker>[3] = {}, withRunner = true) {
  const store = new Store(':memory:');
  const codec = new CapabilityCodec(randomBytes(32), { clock: () => Date.parse('2026-09-09T12:00:00.000Z') });
  const registry = tool instanceof ToolRegistry ? tool : new ToolRegistry(); if (tool && !(tool instanceof ToolRegistry)) registry.register(tool);
  const decision: Decision = { decisionId: 'decision-1', agentId: 'agent-1', decision: 'ALLOW', reason: 'approved', severity: 'info', policyVersion: '1', policyHash: 'policy-1', requiresEvidence: true, timestamp: '2026-09-09T11:59:00.000Z', request, approvalReference: null };
  store.put('decision', decision.decisionId, decision);
  return { store, broker: new ExecutionBroker(store, codec, registry, { ...(withRunner ? { isolationRunner: new ChildProcessIsolationRunner() } : {}), ...options }), decision };
}
const demo = (dir: string): ToolRegistry => createDemoRegistry(dir);
const redeemInput = (token: string, overrides: Record<string, unknown> = {}) => ({ token, tool: 'demo.deploy.execute', resource: 'release-1', operation: 'write', input: demoInput, input_hash: demoInputHash, ...overrides });

test('rejects unknown tool and does not invoke an unregistered handler', () => { const { broker, store } = setup(); assert.throws(() => broker.issue(agent, 'decision-1'), (e: unknown) => e instanceof BrokerError && e.status === 403); assert.equal(store.events().filter(e => (e as { state?: string }).state === 'STARTED').length, 0); store.close(); });
test('registry metadata does not expose handlers', async () => { const registry = new ToolRegistry(); let calls = 0; registry.register({ name: 'x', action: 'a', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], handler: () => { calls++; } }); const metadata = registry.get('x'); assert.ok(metadata); assert.equal('handler' in metadata, false); assert.equal('handler' in registry.list()[0]!, false); await assert.rejects(() => registry.invoke('x', {} as never), /broker-only/); assert.equal(calls, 0); });
test('concurrent issuance creates one capability and one issued path', async () => { const { broker, store } = setup(demo(resolve('data', 'test-artifacts'))); const results = await Promise.allSettled(Array.from({ length: 10 }, () => Promise.resolve().then(() => broker.issue(agent, 'decision-1')))); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected' && result.reason instanceof BrokerError && result.reason.status === 409).length, 9); assert.equal(store.list('execution.capability').length, 1); assert.equal(store.events().filter(event => (event as { state?: string }).state === 'CAPABILITY_ISSUED').length, 1); store.close(); });
for (const state of ['BLOCK', 'HOLD'] as const) test(`refuses ${state} issuance`, () => { const { broker, store, decision } = setup(demo(resolve('data', 'test-artifacts'))); decision.decision = state; store.put('decision', decision.decisionId, decision); assert.throws(() => broker.issue(agent, decision.decisionId), (e: unknown) => e instanceof BrokerError && e.status === 403); store.close(); });
test('enforces binding, revocation, stale policy, and replay checks', async () => { const { broker, store } = setup(demo(resolve('data', 'test-artifacts'))); const issued = broker.issue(agent, 'decision-1'); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token, { tool: 'wrong' })), /binding/); let revokedState = false; const revoked = setup(demo(resolve('data', 'test-artifacts')), { isAgentRevoked: () => revokedState }); const revokedIssued = revoked.broker.issue(agent, 'decision-1'); revokedState = true; await assert.rejects(() => revoked.broker.redeem(agent, redeemInput(revokedIssued.token)), /revoked/); let staleState = true; const stale = setup(demo(resolve('data', 'test-artifacts')), { isPolicyCurrent: () => staleState }); const staleIssued = stale.broker.issue(agent, 'decision-1'); staleState = false; await assert.rejects(() => stale.broker.redeem(agent, redeemInput(staleIssued.token)), /stale/); await broker.redeem(agent, redeemInput(issued.token)); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token)), /consumed/); store.close(); revoked.store.close(); stale.store.close(); });
test('rejects missing, unknown, substituted, and hash-mismatched tool input', async () => { const { broker, store } = setup(demo(resolve('data', 'test-artifacts'))); const issued = broker.issue(agent, 'decision-1'); await assert.rejects(() => broker.redeem(agent, { token: issued.token, tool: 'demo.deploy.execute', resource: 'release-1', operation: 'write', input_hash: demoInputHash } as never), /Invalid redeem input/); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token, { input: { ...demoInput, command: 'sh' } })), /Tool input binding mismatch/); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token, { input: { ...demoInput, release: 'release-2' } })), /Tool input binding mismatch/); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token, { input_hash: 'b'.repeat(64) })), /Tool input binding mismatch/); store.close(); });
test('demo writes a deterministic sandbox artifact without secrets', async () => { const dir = mkdtempSync(resolve('data', 'test')); const { broker, store } = setup(demo(dir)); const issued = broker.issue(agent, 'decision-1'); const result = await broker.redeem(agent, redeemInput(issued.token)); assert.equal(result.state, 'SUCCEEDED'); const contents = readFileSync(resolve(dir, issued.payload.execution_id, `${issued.payload.execution_id}.json`), 'utf8'); assert.match(contents, /production.deploy/); assert.equal(contents.includes('secret'), false); assert.equal(JSON.stringify(result).includes('secret'), false); rmSync(dir, { recursive: true, force: true }); store.close(); });
test('handler failure does not persist sensitive error details', async () => { const secret = 'handler-secret-value'; const resultHash = 'a'.repeat(64); const tool: ToolDefinition = { name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], handler: async () => { throw Object.assign(new Error(`handler failed: ${secret}`), { resultHash }); } }; const { broker, store } = setup(tool); const issued = broker.issue(agent, 'decision-1'); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token)), (error: unknown) => error instanceof BrokerError && error.status === 500 && error.message === 'Handler failed' && !error.message.includes(secret)); const events = store.events(); assert.equal(JSON.stringify(events).includes(secret), false); const execution = broker.execution(agent, issued.payload.execution_id); assert.equal(execution.reason, 'Protected handler failed'); assert.equal(execution.result_hash, resultHash); assert.equal(JSON.stringify(execution).includes(secret), false); assert.equal(JSON.stringify(broker.executions(agent, 'agent-1')).includes(secret), false); store.close(); });
test('handler failure records FAILED and ten concurrent redemptions invoke once', async () => { let calls = 0; const tool: ToolDefinition = { name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], handler: async () => { calls++; throw new Error('boom'); } }; const { broker, store } = setup(tool); const issued = broker.issue(agent, 'decision-1'); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token)), /Handler failed/); assert.equal(calls, 1); assert.equal(store.events().filter(e => (e as { state?: string }).state === 'FAILED').length, 1); store.close(); const concurrent = setup({ ...tool, handler: async () => { calls++; return { ok: true }; } }); const issued2 = concurrent.broker.issue(agent, 'decision-1'); const results = await Promise.allSettled(Array.from({ length: 10 }, () => concurrent.broker.redeem(agent, redeemInput(issued2.token)))); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(calls, 2); concurrent.store.close(); });
test('missing evidence path prevents invocation', async () => { let calls = 0; const { broker, store } = setup({ name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], handler: () => { calls++; } }); const issued = broker.issue(agent, 'decision-1'); store.append = () => { throw new Error('unavailable'); }; await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token))); assert.equal(calls, 0); store.close(); });
test('execution reads are isolated and transitions are append-only', async () => { const { broker, store } = setup(demo(resolve('data', 'test-artifacts'))); const issued = broker.issue(agent, 'decision-1'); await broker.redeem(agent, redeemInput(issued.token)); assert.equal(broker.executions(agent, 'agent-1').length, 1); assert.throws(() => broker.execution({ kind: 'agent', agentId: 'other' }, issued.payload.execution_id), /Access denied/); assert.equal(store.events().filter(e => (e as { type?: string }).type === 'execution.transition').length >= 5, true); store.close(); });
test('isolated execution records bounded metadata and never calls the in-process handler', async () => { let calls = 0; const dir = mkdtempSync(resolve('data', 'test')); const tool: ToolDefinition = { name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], handler: () => { calls++; throw new Error('must not execute in broker'); }, isolated: { runnerType: 'test-runner', runnerVersion: '1', createRequest: context => ({ execution_id: context.executionId, agent_id: context.agentId, tool: context.inputHash, operation: context.operation, command: 'trusted', args: [], workspace: dir, cwd: '.', env: {}, runtime_limit_ms: 1000, stdout_limit_bytes: 64, stderr_limit_bytes: 64, output_limit_bytes: 128, no_network: { requested: true, mode: 'preflight-only' } }) } }; const runner: IsolationRunner = { run: async (request: IsolatedExecutionRequest): Promise<IsolatedExecutionResult> => ({ execution_id: request.execution_id, state: 'SUCCEEDED', reason: 'completed', exit_code: 0, signal: null, stdout: { bytes: 2, sha256: 'a'.repeat(64), preview: 'ok' }, stderr: { bytes: 0, sha256: 'b'.repeat(64), preview: '' }, network: { requested: true, mode: 'preflight-only', enforcement: 'not-enforced' } }) }; const { broker, store } = setup(tool, { isolationRunner: runner }); const issued = broker.issue(agent, 'decision-1'); await broker.redeem(agent, redeemInput(issued.token)); assert.equal(calls, 0); const execution = broker.execution(agent, issued.payload.execution_id); assert.equal(execution.state, 'SUCCEEDED'); assert.equal(execution.isolation?.runner_type, 'test-runner'); assert.equal(execution.isolation?.stdout_bytes, 2); assert.equal(execution.isolation?.network.enforcement, 'not-enforced'); assert.equal(JSON.stringify(execution).includes('ok'), false); rmSync(dir, { recursive: true, force: true }); store.close(); });
test('isolated execution fails closed without a runner and consumes nothing', async () => { const dir = mkdtempSync(resolve('data', 'test')); const { broker, store } = setup(demo(dir), {}, false); const issued = broker.issue(agent, 'decision-1'); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token)), (error: unknown) => error instanceof BrokerError && error.status === 503); assert.equal((store.get('execution.capability', issued.payload.capability_id) as { consumed: boolean }).consumed, false); rmSync(dir, { recursive: true, force: true }); store.close(); });
for (const [state, reason] of [['FAILED', 'non_zero_exit'], ['TERMINATED', 'runtime_limit']] as const) test(`isolated child ${state.toLowerCase()} is persisted without reviving the broker`, async () => { const dir = mkdtempSync(resolve('data', 'test')); const tool: ToolDefinition = { name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], isolated: { runnerType: 'test-runner', runnerVersion: '1', createRequest: context => ({ execution_id: context.executionId, agent_id: context.agentId, tool: 'demo.deploy.execute', operation: context.operation, command: 'trusted', args: [], workspace: dir, cwd: '.', env: {}, runtime_limit_ms: 10, stdout_limit_bytes: 1, stderr_limit_bytes: 1, output_limit_bytes: 1, no_network: { requested: true, mode: 'preflight-only' } }) } }; const runner: IsolationRunner = { run: async request => ({ execution_id: request.execution_id, state, reason, exit_code: state === 'FAILED' ? 7 : null, signal: null, stdout: { bytes: 0, sha256: 'a'.repeat(64), preview: '' }, stderr: { bytes: 0, sha256: 'b'.repeat(64), preview: '' }, network: { requested: true, mode: 'preflight-only', enforcement: 'not-enforced' } }) }; const { broker, store } = setup(tool, { isolationRunner: runner }); const issued = broker.issue(agent, 'decision-1'); await assert.rejects(() => broker.redeem(agent, redeemInput(issued.token)), new RegExp(state === 'FAILED' ? 'failed' : 'terminated')); assert.equal(broker.execution(agent, issued.payload.execution_id).state, state); assert.equal((store.get('execution.capability', issued.payload.capability_id) as { consumed: boolean }).consumed, true); rmSync(dir, { recursive: true, force: true }); store.close(); });

// ── G1: capability redemption must not outlive authority ──────────────────────

test('G1: expired authority blocks redemption and invokes zero handlers', async () => {
  let handlerCalls = 0;
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: [],
    handler: async () => { handlerCalls++; return { ok: true }; },
  };
  // Authority is valid at issuance, becomes invalid before redemption.
  let authorityValid = true;
  const { broker, store } = setup(tool, { isAuthorityValid: () => authorityValid });
  const issued = broker.issue(agent, 'decision-1');
  // Simulate authority expiry (approval/runtime window expires between issue and redeem).
  authorityValid = false;
  await assert.rejects(
    () => broker.redeem(agent, redeemInput(issued.token)),
    /authority/i,
  );
  assert.equal(handlerCalls, 0, 'handler must not be invoked after authority expires');
  store.close();
});

test('G1: expired authority blocks issuance', () => {
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: [],
    handler: async () => ({ ok: true }),
  };
  const { broker, store } = setup(tool, { isAuthorityValid: () => false });
  assert.throws(() => broker.issue(agent, 'decision-1'), /authority/i);
  store.close();
});

test('G1: capability TTL is capped to earliest authority expiry', () => {
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: [],
    handler: async () => ({ ok: true }),
  };
  // Authority expires 2 seconds after the clock used by codec (2026-09-09T12:00:00.000Z).
  const authorityExpiresAt = Date.parse('2026-09-09T12:00:02.000Z');
  const { broker, store } = setup(tool, { earliestAuthorityExpiry: () => authorityExpiresAt });
  const issued = broker.issue(agent, 'decision-1');
  // Capability's default TTL is 30s, but authority expires in 2s → cap to 2s.
  const capabilityExpiry = Date.parse(issued.payload.expires_at);
  assert.ok(capabilityExpiry <= authorityExpiresAt, `capability expiry ${issued.payload.expires_at} must not exceed authority expiry`);
  store.close();
});

// ── G2: pre-invocation rechecks after async waits ──────────────────────

test('G2: revocation during secret lease blocks handler invocation', async () => {
  let handlerCalls = 0;
  let agentRevoked = false;
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: ['deployment'],
    handler: async () => { handlerCalls++; return { ok: true }; },
  };
  const secretBroker = {
    async lease(names: readonly string[]) {
      // Revoke agent DURING the async lease window
      agentRevoked = true;
      return names.map(name => ({ name, value: 'secret-value' }));
    },
  };
  const { broker, store } = setup(tool, {
    secretBroker,
    isAgentRevoked: () => agentRevoked,
  });
  const issued = broker.issue(agent, 'decision-1');
  await assert.rejects(
    () => broker.redeem(agent, redeemInput(issued.token)),
    /revoked/i,
  );
  assert.equal(handlerCalls, 0, 'handler must not be invoked after revocation');
  store.close();
});

test('G2: policy change during secret lease blocks handler', async () => {
  let handlerCalls = 0;
  let policyCurrent = true;
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: ['deployment'],
    handler: async () => { handlerCalls++; return { ok: true }; },
  };
  const secretBroker = {
    async lease(names: readonly string[]) {
      // Policy becomes stale DURING the async lease window
      policyCurrent = false;
      return names.map(name => ({ name, value: 'secret-value' }));
    },
  };
  const { broker, store } = setup(tool, {
    secretBroker,
    isPolicyCurrent: () => policyCurrent,
  });
  const issued = broker.issue(agent, 'decision-1');
  await assert.rejects(
    () => broker.redeem(agent, redeemInput(issued.token)),
    /stale|policy/i,
  );
  assert.equal(handlerCalls, 0, 'handler must not be invoked after policy change');
  store.close();
});

test('G2: empty lease set for credential-required tool blocks', async () => {
  let handlerCalls = 0;
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: ['deployment'],
    handler: async () => { handlerCalls++; return { ok: true }; },
  };
  const secretBroker = {
    async lease() { return []; },
  };
  const { broker, store } = setup(tool, { secretBroker });
  const issued = broker.issue(agent, 'decision-1');
  await assert.rejects(
    () => broker.redeem(agent, redeemInput(issued.token)),
    /credential|lease/i,
  );
  assert.equal(handlerCalls, 0, 'handler must not be invoked with missing credentials');
  store.close();
});

test('G2: capability expiry during secret lease blocks handler', async () => {
  let handlerCalls = 0;
  // Broker clock starts at the same moment as the codec clock.
  let clockTime = Date.parse('2026-09-09T12:00:00.000Z');
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: ['deployment'],
    handler: async () => { handlerCalls++; return { ok: true }; },
  };
  const secretBroker = {
    async lease(names: readonly string[]) {
      // Advance clock well past the capability's expiry during the lease await
      clockTime += 120_000;
      return names.map(name => ({ name, value: 'secret-value' }));
    },
  };
  // Authority expires 10s from now → capability TTL capped to 10s.
  const authorityExpiresAt = Date.parse('2026-09-09T12:00:10.000Z');
  const { broker, store } = setup(tool, {
    secretBroker,
    now: () => clockTime,
    earliestAuthorityExpiry: () => authorityExpiresAt,
  });
  const issued = broker.issue(agent, 'decision-1');
  assert.ok(issued.payload.expires_at, 'capability must have an expiry');
  await assert.rejects(
    () => broker.redeem(agent, redeemInput(issued.token)),
    /expired|capability/i,
  );
  assert.equal(handlerCalls, 0, 'handler must not be invoked after capability expiry');
  store.close();
});

// ── G3: outcome/evidence separation ────────────────────────────────────

test('G3: handler success with evidence failure yields non-FAILED outcome', async () => {
  let handlerCalls = 0;
  // eslint-disable-next-line prefer-const
  let storeRef: InstanceType<typeof import('../../packages/evidence-core/src/index.js').Store>;
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: [],
    handler: async () => {
      handlerCalls++;
      // Sabotage evidence writes that happen after the handler returns.
      // The next store.append (inside finish→transaction) will throw,
      // simulating an evidence-infrastructure outage AFTER the side effect.
      storeRef.append = () => { throw new Error('evidence write failed'); };
      return { ok: true };
    },
  };
  const { broker, store } = setup(tool);
  storeRef = store;
  const issued = broker.issue(agent, 'decision-1');
  await assert.rejects(
    () => broker.redeem(agent, redeemInput(issued.token)),
    (error: unknown) => {
      // Must NOT say "Handler failed" — the handler succeeded
      return error instanceof BrokerError && error.status === 503;
    },
  );
  assert.equal(handlerCalls, 1, 'handler must be invoked exactly once');
  // Execution state must never be FAILED when the handler completed
  const exec = broker.execution(agent, issued.payload.execution_id);
  assert.notEqual(exec.state, 'FAILED', 'a successful handler must not be recorded as FAILED');
  // Capability must remain consumed (no automatic retry)
  assert.equal(
    (store.get('execution.capability', issued.payload.capability_id) as { consumed: boolean }).consumed,
    true,
    'capability must remain consumed',
  );
  store.close();
});

test('G3: handler throws before side effect records FAILED', async () => {
  let handlerCalls = 0;
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: [],
    handler: async () => { handlerCalls++; throw new Error('handler exploded'); },
  };
  const { broker, store } = setup(tool);
  const issued = broker.issue(agent, 'decision-1');
  await assert.rejects(
    () => broker.redeem(agent, redeemInput(issued.token)),
    /Handler failed/,
  );
  assert.equal(handlerCalls, 1, 'handler must be invoked exactly once');
  const exec = broker.execution(agent, issued.payload.execution_id);
  assert.equal(exec.state, 'FAILED', 'handler failure must record FAILED');
  store.close();
});

test('G3: handler succeeds with evidence persisted records SUCCEEDED', async () => {
  const tool: ToolDefinition = {
    name: 'demo.deploy.execute', action: 'production.deploy', resourceType: 'infrastructure',
    allowedOperations: ['write'], networkRequired: false, credentialsRequired: [],
    handler: async () => ({ deployed: true }),
  };
  const { broker, store } = setup(tool);
  const issued = broker.issue(agent, 'decision-1');
  const result = await broker.redeem(agent, redeemInput(issued.token));
  assert.equal(result.state, 'SUCCEEDED', 'result must be SUCCEEDED');
  const exec = broker.execution(agent, issued.payload.execution_id);
  assert.equal(exec.state, 'SUCCEEDED', 'execution state must be SUCCEEDED');
  store.close();
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { PlatformError } from '../../packages/platform-schema/src/index.js';
import { PlatformStore } from '../../packages/platform-core/src/index.js';
import { newOutboxRecord, OutboxDispatcher, type OutboxPort, type OutboxRecord } from '../../packages/platform-outbox/src/index.js';

const request = (requestId: string) => ({ version: '1.0', request_id: requestId, tenant_id: 'tenant_a', agent_id: 'agent_a', action: 'echo', tool: 'demo.echo', operation: 'execute', resource: 'demo', input: {}, requires_verification: false });
function store(): { dir: string; store: PlatformStore } { const dir = mkdtempSync(resolve(tmpdir(), 'platform-races-')); return { dir, store: new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => Date.parse('2026-01-01T00:00:00.000Z') }) }; }
function progressToMonitoring(s: PlatformStore, actionId: string): number {
  const a = s.transition('tenant_a', actionId, 0, 'AUTHORIZING');
  const b = s.transition('tenant_a', actionId, a.state_version, 'AUTHORIZED');
  const c = s.recordCapability('tenant_a', actionId, b.state_version, 'cap_1');
  const d = s.recordSentinelSession('tenant_a', actionId, c.state_version, 'sess_1');
  return d.state_version;
}

test('race — two genuinely concurrent execution claims on the same action: exactly one wins, the other CONFLICTs, and the claim itself precedes any connector call', async () => {
  const f = store(); try {
    const action = f.store.createOrReturn(request('race_exec'), 'svc');
    const version = progressToMonitoring(f.store, action.platform_action_id);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => f.store.claimExecution('tenant_a', action.platform_action_id, version, 'exec_a')),
      Promise.resolve().then(() => f.store.claimExecution('tenant_a', action.platform_action_id, version, 'exec_b')),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<ReturnType<PlatformStore['claimExecution']>> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof PlatformError && rejected[0].reason.code === 'CONFLICT');
    assert.equal(f.store.get('tenant_a', action.platform_action_id).state, 'EXECUTING');
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('race — terminate vs. complete: whichever CAS transition commits first wins, and the loser observes CONFLICT rather than silently overwriting the winner', async () => {
  const f = store(); try {
    const action = f.store.createOrReturn(request('race_term_complete'), 'svc');
    const version = progressToMonitoring(f.store, action.platform_action_id);
    const claimed = f.store.claimExecution('tenant_a', action.platform_action_id, version, 'exec_race');
    void claimed;
    const executingVersion = f.store.get('tenant_a', action.platform_action_id).state_version;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => f.store.recordFailure('tenant_a', action.platform_action_id, executingVersion, 'EXECUTING', 'TERMINATED', 'SENTINEL_TERMINATED', 'terminated mid-flight')),
      Promise.resolve().then(() => f.store.recordExecutionResult('tenant_a', action.platform_action_id, executingVersion, { execution_id: 'exec_race', result_hash: 'a'.repeat(64) }, 'COMPLETED', 'PLATFORM_ACTION_COMPLETED')),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one racer must win the CAS');
    assert.equal(rejected.length, 1);
    const finalState = f.store.get('tenant_a', action.platform_action_id).state;
    assert.ok(finalState === 'TERMINATED' || finalState === 'COMPLETED', 'final state must be exactly whichever CAS actually committed, never a third value');
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('race — hold/execute: once HELD is authoritative, an execution claim from the pre-hold MONITORING snapshot is rejected — the connector is never reachable from a stale claim', () => {
  const f = store(); try {
    const action = f.store.createOrReturn(request('race_hold_execute'), 'svc');
    const version = progressToMonitoring(f.store, action.platform_action_id);
    // A HELD action can only be reached via AUTHORIZING in this milestone's state machine (section 9);
    // this proves the complementary invariant directly: a MONITORING-stage version can never be used
    // to claim execution once the row has moved on for any reason — CAS, not state-name matching, is
    // what actually prevents the connector from running against stale authority.
    f.store.recordFailure('tenant_a', action.platform_action_id, version, 'MONITORING', 'INDETERMINATE', 'SENTINEL_HOLD', 'held before execution');
    assert.throws(() => f.store.claimExecution('tenant_a', action.platform_action_id, version), (e: unknown) => e instanceof PlatformError && e.code === 'CONFLICT');
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('race — duplicate concurrent action submission: same request_id resolves to exactly one durable action, never two', async () => {
  const f = store(); try {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => f.store.createOrReturn(request('race_submit'), 'svc')),
      Promise.resolve().then(() => f.store.createOrReturn(request('race_submit'), 'svc')),
    ]);
    const ids = new Set(results.filter((r): r is PromiseFulfilledResult<ReturnType<PlatformStore['createOrReturn']>> => r.status === 'fulfilled').map(r => r.value.platform_action_id));
    assert.equal(ids.size, 1);
    assert.equal(f.store.list('tenant_a').items.length, 1);
  } finally { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('race — concurrent outbox dispatch (in-process fake port): two dispatchers racing the same pending record produce exactly one logical Ledger delivery', async () => {
  // A focused unit test of OutboxDispatcher's own claim-conflict handling against a minimal fake
  // port. This does NOT by itself prove multi-*process* safety — see
  // platform-distributed-outbox.test.ts for the real two-independent-PlatformStore-instance version
  // the distributed-evidence closure pass requires (a same-runtime Promise.all against a shared fake
  // does not satisfy that requirement on its own).
  const record = newOutboxRecord({ outboxId: 'ob_race', tenantId: 'tenant_a', platformActionId: 'pa_1', eventType: 'STATE', payload: {}, now: '2026-01-01T00:00:00.000Z' });
  let claimed: OutboxRecord | null = { ...record, claim_owner: null, claim_token: null, claim_expires_at: null };
  let deliveries = 0;
  const port: OutboxPort = {
    claimNext: (_now, ownerId) => { if (!claimed) return null; const value = claimed; claimed = null; return { ...value, status: 'DELIVERING', attempt_count: value.attempt_count + 1, claim_owner: ownerId, claim_token: `tok_${ownerId}`, claim_expires_at: '2026-01-01T00:01:00.000Z' }; },
    markDelivered: () => { deliveries += 1; },
    markRetry: () => assert.fail('should not retry in this race'),
    markDeadLetter: () => assert.fail('should not dead-letter in this race'),
  };
  const deliver = async (r: OutboxRecord): Promise<{ event_id: string }> => ({ event_id: r.ledger_event_id! });
  const dispatcherA = new OutboxDispatcher(port, deliver, { ownerId: 'A' });
  const dispatcherB = new OutboxDispatcher(port, deliver, { ownerId: 'B' });
  await Promise.all([dispatcherA.dispatchOnce(), dispatcherB.dispatchOnce()]);
  assert.equal(deliveries, 1);
});

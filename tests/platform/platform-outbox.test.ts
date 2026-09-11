import assert from 'node:assert/strict';
import test from 'node:test';
import { computeBackoffMs, newOutboxRecord, OutboxDispatcher, outboxLedgerEventId, type OutboxPort } from '../../packages/platform-outbox/src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PlatformStore } from '../../packages/platform-core/src/index.js';

test('outbox retries first failure in one second and mandates deterministic ledger identity', async () => {
  const original = newOutboxRecord({ outboxId: 'ob_1', tenantId: 'tenant_a', platformActionId: 'pa_1', eventType: 'STATE', payload: {}, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(original.ledger_event_id, outboxLedgerEventId('ob_1')); assert.equal(computeBackoffMs(1), 1000);
  let claimed = false; let retryAt = '';
  const port: OutboxPort = {
    claimNext: () => { if (claimed) return null; claimed = true; return { ...original, status: 'DELIVERING', attempt_count: 1, claim_owner: 'o', claim_token: 'tok_1', claim_expires_at: '2026-01-01T00:00:30.000Z' }; },
    markDelivered: () => assert.fail('unexpected delivery'),
    markRetry: (_id, _tenant, _token, _error, next) => { retryAt = next; },
    markDeadLetter: () => assert.fail('unexpected dead letter'),
  };
  await new OutboxDispatcher(port, async () => { throw new Error('ledger unavailable'); }, { clock: () => Date.parse('2026-01-01T00:00:00.000Z') }).dispatchOnce();
  assert.equal(retryAt, '2026-01-01T00:00:01.000Z');
  let badClaimed = false;
  const badPort: OutboxPort = {
    claimNext: () => { if (badClaimed) return null; badClaimed = true; return { ...original, status: 'DELIVERING', attempt_count: 1, claim_owner: 'o', claim_token: 'tok_2', claim_expires_at: '2026-01-01T00:00:30.000Z' }; },
    markDelivered: () => assert.fail('must reject non-deterministic id'), markRetry: () => {}, markDeadLetter: () => {},
  };
  await new OutboxDispatcher(badPort, async () => ({ event_id: 'random_event' })).dispatchOnce();
});

test('startup requeues an interrupted outbox delivery claim once its lease has expired — never while the lease is still live', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-outbox-')); const path = resolve(dir, 'platform.sqlite');
  try {
    const time = Date.parse('2026-01-01T00:00:00.000Z'); const store = new PlatformStore(path, { clock: () => time });
    const action = store.createOrReturn({ version: '1.0', request_id: 'req_1', tenant_id: 'tenant_a', agent_id: 'agent_a', action: 'echo', tool: 'demo.echo', operation: 'execute', resource: 'demo', input: {}, requires_verification: false }, 'service_a');
    const claimed = store.claimNext('2026-01-01T00:00:00.000Z', 'owner_a', 500); // short 500ms lease
    assert.ok(claimed); store.close();

    // Reopening immediately (lease not yet expired) must leave the claim strictly alone — a
    // still-live lease could belong to a different, still-running process (distributed-evidence
    // closure, section 1), not necessarily this restarting one.
    const soonReopened = new PlatformStore(path, { clock: () => time + 100 });
    assert.equal(soonReopened.listOutbox('tenant_a', action.platform_action_id)[0]?.status, 'DELIVERING');
    soonReopened.close();

    // Reopening after the lease has genuinely expired recovers it to FAILED, with its deterministic
    // ledger identity intact, and it becomes claimable again.
    const reopened = new PlatformStore(path, { clock: () => time + 1_000 });
    const recovered = reopened.listOutbox('tenant_a', action.platform_action_id)[0];
    assert.ok(recovered); assert.equal(recovered.status, 'FAILED'); assert.equal(recovered.ledger_event_id, outboxLedgerEventId(recovered.outbox_id));
    assert.equal(reopened.claimNext('2026-01-01T00:00:01.000Z', 'owner_b', 30_000)?.outbox_id, recovered.outbox_id);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

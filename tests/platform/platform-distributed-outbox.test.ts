import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Ledger, LedgerStore, readerPrincipal, writerPrincipal } from '../../packages/ledger-core/src/index.js';
import { outboxLedgerEventId } from '../../packages/platform-outbox/src/index.js';
import { PlatformLedgerDispatcher, PlatformStore } from '../../packages/platform-core/src/index.js';

const TENANT = 'tenant_a';
const request = (requestId: string) => ({ version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: 'agent_a', action: 'echo', tool: 'demo.echo', operation: 'execute', resource: 'demo', input: {}, requires_verification: false });

function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-distributed-outbox-'));
  const dbPath = resolve(dir, 'platform.sqlite');
  const ledgerStore = new LedgerStore(resolve(dir, 'ledger.sqlite'));
  const ledger = new Ledger(ledgerStore);
  const writer = writerPrincipal('platform-ledger-writer', TENANT, ['platform']);
  const reader = readerPrincipal('platform-ledger-reader', TENANT);
  return { dir, dbPath, ledgerStore, ledger, writer, reader };
}
function cleanup(f: ReturnType<typeof fixture>) { f.ledgerStore.close(); rmSync(f.dir, { recursive: true, force: true }); }

test('two independently live PlatformStore instances sharing one SQLite database: only one may hold an active delivery claim at a time', async () => {
  const f = fixture(); try {
    const time = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => time;
    // Two genuinely separate PlatformStore instances — separate DatabaseSync connections — opening
    // the SAME file, mirroring the exact technique the accepted Sentinel concurrency-closure pass
    // used for "two separate SentinelRuntime instances sharing one SQLite file" (not a same-runtime
    // Promise.all against one shared instance/fake, which this closure explicitly does not accept).
    const storeA = new PlatformStore(f.dbPath, { clock });
    const storeB = new PlatformStore(f.dbPath, { clock });
    // Five independent actions -> five PLATFORM_ACTION_RECEIVED outbox records, so both dispatchers
    // genuinely have work to race over, not just one record only one of them can ever see.
    const actionIds: string[] = [];
    for (let i = 0; i < 5; i += 1) actionIds.push(storeA.createOrReturn(request(`dist_${i}`), 'svc').platform_action_id);

    const dispatcherA = new PlatformLedgerDispatcher(storeA, { append: input => f.ledger.append(f.writer, input) }, { clock, ownerId: 'process-A' });
    const dispatcherB = new PlatformLedgerDispatcher(storeB, { append: input => f.ledger.append(f.writer, input) }, { clock, ownerId: 'process-B' });

    const [resultA, resultB] = await Promise.all([dispatcherA.dispatchOnce(), dispatcherB.dispatchOnce()]);
    assert.equal(resultA.delivered + resultB.delivered, 5, 'all five records must be delivered exactly once between the two processes');
    assert.equal(resultA.failed + resultB.failed, 0);

    for (const actionId of actionIds) {
      const records = storeA.listOutbox(TENANT, actionId);
      assert.equal(records.length, 1);
      assert.equal(records[0]?.status, 'DELIVERED', 'no lost evidence — every record reaches DELIVERED');
      const events = f.ledger.getEventsByCorrelation(f.reader, storeA.get(TENANT, actionId).correlation_id).items;
      assert.equal(events.length, 1, 'no duplicate logical Ledger event for any action');
    }
    storeA.close(); storeB.close();
  } finally { cleanup(f); }
});

test('outbox lease is not stealable before expiry: a second live instance racing an active, unexpired claim gets nothing', () => {
  const f = fixture(); try {
    const time = Date.parse('2026-01-01T00:00:00.000Z');
    const storeA = new PlatformStore(f.dbPath, { clock: () => time });
    const storeB = new PlatformStore(f.dbPath, { clock: () => time });
    const action = storeA.createOrReturn(request('lease_no_steal'), 'svc');
    const claimedByA = storeA.claimNext('2026-01-01T00:00:00.000Z', 'process-A', 30_000);
    assert.ok(claimedByA);
    const attemptByB = storeB.claimNext('2026-01-01T00:00:00.000Z', 'process-B', 30_000);
    assert.equal(attemptByB, null, 'a live, unexpired lease must not be independently claimable by a second process');
    assert.equal(storeA.listOutbox(TENANT, action.platform_action_id)[0]?.claim_owner, 'process-A');
    storeA.close(); storeB.close();
  } finally { cleanup(f); }
});

test('claim owner dies before delivery: once its lease expires, a second live instance recovers and delivers the record', async () => {
  const f = fixture(); try {
    let time = Date.parse('2026-01-01T00:00:00.000Z');
    const storeA = new PlatformStore(f.dbPath, { clock: () => time });
    const action = storeA.createOrReturn(request('owner_death'), 'svc');
    // Process A claims with a short lease, then dies — no deliver(), no mark*() call ever happens for
    // this claim. This is the honest way to simulate a real process death in-process: never invoke
    // the dispatcher's own delivery/ack path for this attempt at all.
    const claimed = storeA.claimNext('2026-01-01T00:00:00.000Z', 'process-A-doomed', 1_000);
    assert.ok(claimed);
    assert.equal(storeA.get(TENANT, action.platform_action_id).state, 'RECEIVED'); // sanity: action itself is unaffected by outbox mechanics
    storeA.close(); // the "process" that owned the claim is gone; the lease itself lives on in the shared file until it expires

    time += 2_000; // advance past the 1s lease
    const storeB = new PlatformStore(f.dbPath, { clock: () => time });
    const dispatcherB = new PlatformLedgerDispatcher(storeB, { append: input => f.ledger.append(f.writer, input) }, { clock: () => time, ownerId: 'process-B-recovers' });
    const result = await dispatcherB.dispatchOnce();
    assert.equal(result.delivered, 1);
    const record = storeB.listOutbox(TENANT, action.platform_action_id)[0];
    assert.equal(record?.status, 'DELIVERED');
    assert.equal(record?.claim_owner, 'process-B-recovers', 'the record is not left permanently stuck in DELIVERING — a live owner eventually delivers it');
    storeB.close();
  } finally { cleanup(f); }
});

test('crash after Ledger append but before local acknowledgement: retry reuses the same deterministic event id and produces exactly one logical Ledger event', async () => {
  const f = fixture(); try {
    let time = Date.parse('2026-01-01T00:00:00.000Z');
    const storeA = new PlatformStore(f.dbPath, { clock: () => time });
    const action = storeA.createOrReturn(request('crash_after_append'), 'svc');
    const dispatcherA = new PlatformLedgerDispatcher(storeA, { append: input => f.ledger.append(f.writer, input) }, { clock: () => time });

    // Process A claims the record and successfully appends to the REAL Ledger — then crashes before
    // it ever gets to call markDelivered. This is done by reaching directly for the claim + the
    // dispatcher's own event-shaping logic, bypassing dispatchOnce()'s own mark* call entirely, which
    // is the only honest way to simulate "the local acknowledgement never happened" without actually
    // killing a process.
    const claimed = storeA.claimNext('2026-01-01T00:00:00.000Z', 'process-A-crashing', 1_000);
    assert.ok(claimed);
    const appended = f.ledger.append(f.writer, dispatcherA.toLedgerEvent(claimed));
    assert.equal(appended.event_id, outboxLedgerEventId(claimed.outbox_id));
    // No markDelivered call — process A is now gone.
    storeA.close();

    time += 2_000; // lease expires
    const storeB = new PlatformStore(f.dbPath, { clock: () => time });
    const dispatcherB = new PlatformLedgerDispatcher(storeB, { append: input => f.ledger.append(f.writer, input) }, { clock: () => time, ownerId: 'process-B' });
    const result = await dispatcherB.dispatchOnce();
    assert.equal(result.delivered, 1, 'the retried delivery must still be reported as delivered — Ledger absorbed the idempotent re-append');

    const events = f.ledger.getEventsByCorrelation(f.reader, action.correlation_id).items;
    assert.equal(events.length, 1, 'exactly one logical Ledger event, not two, despite two append attempts');
    assert.equal(events[0]?.event_id, outboxLedgerEventId(claimed.outbox_id));
    assert.equal(storeB.listOutbox(TENANT, action.platform_action_id)[0]?.status, 'DELIVERED');
    storeB.close();
  } finally { cleanup(f); }
});

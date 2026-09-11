import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LedgerStore, Ledger, LedgerError } from '../../packages/ledger-core/src/index.js';
import { setup, baseEvent } from './fixture.js';

test('identical event id with identical content is idempotent (no duplicate row, no error)', () => {
  const { ledger, gw, rd, tenantId } = setup();
  const input = baseEvent({ tenant_id: tenantId, event_id: 'fixed-1' });
  const first = ledger.append(gw, input);
  const second = ledger.append(gw, input);
  assert.equal(first.event_hash, second.event_hash);
  assert.equal(first.sequence, second.sequence);
  assert.equal(ledger.getStream(rd, 'agent:a1').items.length, 1);
});

test('identical event id with different content is a conflict', () => {
  const { ledger, gw, tenantId } = setup();
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'fixed-2', correlation_id: 'agent:a1' }));
  assert.throws(() => ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'fixed-2', correlation_id: 'agent:different' })),
    (e: unknown) => e instanceof LedgerError && e.code === 'EVENT_CONFLICT');
});

test('sequence is monotonic per stream and previous_event_hash chains correctly', () => {
  const { ledger, gw, tenantId } = setup();
  const e1 = ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e1' }));
  const e2 = ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e2' }));
  const e3 = ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e3' }));
  assert.deepEqual([e1.sequence, e2.sequence, e3.sequence], [1, 2, 3]);
  assert.equal(e1.previous_event_hash, 'GENESIS');
  assert.equal(e2.previous_event_hash, e1.event_hash);
  assert.equal(e3.previous_event_hash, e2.event_hash);
});

test('stream head is updated atomically on append', () => {
  const { ledger, store, gw, tenantId } = setup();
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e1' }));
  const e2 = ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e2' }));
  const head = store.streamHead(tenantId, 'agent:a1');
  assert.equal(head?.latest_sequence, 2);
  assert.equal(head?.latest_event_hash, e2.event_hash);
});

test('10 concurrent appends to the same stream produce 10 unique monotonic sequence numbers and one valid chain', async () => {
  const { ledger, gw, ad, tenantId } = setup();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    Promise.resolve().then(() => ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: `concurrent-${i}` })))));
  const sequences = results.map(r => r.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const verification = ledger.verifyStream(ad, 'agent:a1');
  assert.equal(verification.valid, true);
  assert.equal(verification.eventsChecked, 10);
});

test('restart persistence: close and reopen the store, same hashes reconstruct', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-ledger-test-'));
  const path = resolve(dir, 'ledger.sqlite');
  let store = new LedgerStore(path);
  let ledger = new Ledger(store);
  const { gw, rd, tenantId } = setup();
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'p1' }));
  const persisted = ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'p2' }));
  store.close();

  store = new LedgerStore(path);
  ledger = new Ledger(store);
  const stream = ledger.getStream(rd, 'agent:a1').items;
  assert.equal(stream.length, 2);
  assert.equal(stream[1]?.event_hash, persisted.event_hash);
  const verification = ledger.verifyStream(rd, 'agent:a1');
  assert.equal(verification.valid, true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('query filters are parameterized: an injection-shaped filter value is treated as literal data, not SQL', () => {
  const { ledger, store, gw, tenantId } = setup();
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e1', actor: { type: 'AGENT', id: 'a1' } }));
  const maliciousFilter = "a1'; DROP TABLE ledger_events; --";
  assert.equal(store.query(tenantId, { actorId: maliciousFilter }, 50).length, 0);
  assert.equal(store.query(tenantId, { actorId: 'a1' }, 50).length, 1);
});

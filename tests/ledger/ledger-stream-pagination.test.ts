import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUERY_PAGE_SIZE, DEFAULT_QUERY_PAGE_SIZE, LedgerError } from '../../packages/ledger-schema/src/index.js';
import { writerPrincipal, readerPrincipal } from '../../packages/ledger-core/src/index.js';
import { setup, baseEvent } from './fixture.js';

function seed(count: number, streamId = 'agent:page') {
  const ctx = setup();
  for (let i = 0; i < count; i++) {
    ctx.ledger.append(ctx.gw, baseEvent({ tenant_id: ctx.tenantId, event_id: `p-${String(i).padStart(4, '0')}`, stream_id: streamId, correlation_id: streamId }));
  }
  return ctx;
}

test('getStream defaults to a bounded page (DEFAULT_QUERY_PAGE_SIZE)', () => {
  const { ledger, rd } = seed(DEFAULT_QUERY_PAGE_SIZE + 25);
  const page = ledger.getStream(rd, 'agent:page');
  assert.equal(page.items.length, DEFAULT_QUERY_PAGE_SIZE);
  assert.ok(page.nextCursor, 'a further page must be signalled');
});

test('getStream honors a smaller requested limit', () => {
  const { ledger, rd } = seed(20);
  const page = ledger.getStream(rd, 'agent:page', 5);
  assert.equal(page.items.length, 5);
  assert.ok(page.nextCursor);
});

test('getStream clamps a limit above the maximum (documented clamp policy, not rejection)', () => {
  const { ledger, rd } = seed(MAX_QUERY_PAGE_SIZE + 10);
  const page = ledger.getStream(rd, 'agent:page', MAX_QUERY_PAGE_SIZE * 100);
  assert.equal(page.items.length, MAX_QUERY_PAGE_SIZE);
  assert.ok(page.nextCursor, 'clamping must still leave a continuation cursor when more data exists');
});

test('getStream rejects a non-positive limit', () => {
  const { ledger, rd } = seed(3);
  assert.throws(() => ledger.getStream(rd, 'agent:page', 0), (e: unknown) => e instanceof LedgerError && e.code === 'INVALID_EVENT');
  assert.throws(() => ledger.getStream(rd, 'agent:page', -5), (e: unknown) => e instanceof LedgerError && e.code === 'INVALID_EVENT');
});

test('getStream rejects an invalid cursor', () => {
  const { ledger, rd } = seed(3);
  assert.throws(() => ledger.getStream(rd, 'agent:page', 10, 'not-a-valid-cursor!!!'), (e: unknown) => e instanceof LedgerError && e.code === 'INVALID_EVENT');
});

test('continuation cursor retrieves the next page; traversal omits nothing and duplicates nothing', () => {
  const total = 47;
  const { ledger, rd } = seed(total);
  const pageSize = 10;
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = ledger.getStream(rd, 'agent:page', pageSize, cursor);
    pages += 1;
    assert.ok(page.items.length <= pageSize);
    for (const event of page.items) seen.push(event.event_id);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  assert.equal(seen.length, total, 'every event must be visited exactly once');
  assert.equal(new Set(seen).size, total, 'no event may appear on two pages');
  assert.equal(pages, Math.ceil(total / pageSize));
  // Full unpaginated expectation, in canonical order.
  const expected = Array.from({ length: total }, (_, i) => `p-${String(i).padStart(4, '0')}`);
  assert.deepEqual(seen, expected, 'ordering across pages must be deterministic and gap-free');
});

test('ordering remains deterministic and equals sequence order across repeated calls', () => {
  const { ledger, rd } = seed(30);
  const first = ledger.getStream(rd, 'agent:page', 30).items.map(e => e.sequence);
  const second = ledger.getStream(rd, 'agent:page', 30).items.map(e => e.sequence);
  assert.deepEqual(first, second);
  assert.deepEqual(first, Array.from({ length: 30 }, (_, i) => i + 1));
});

test('cross-tenant stream pagination stays isolated', () => {
  const ctx = setup('tenant_a');
  const writerB = writerPrincipal('ledger-writer-gate', 'tenant_b', ['tna-gate']);
  const readerA = readerPrincipal('ledger-reader', 'tenant_a');
  const readerB = readerPrincipal('ledger-reader', 'tenant_b');
  for (let i = 0; i < 12; i++) ctx.ledger.append(ctx.gw, baseEvent({ tenant_id: 'tenant_a', event_id: `a-${i}`, stream_id: 'agent:shared', correlation_id: 'agent:shared' }));
  for (let i = 0; i < 3; i++) ctx.ledger.append(writerB, baseEvent({ tenant_id: 'tenant_b', event_id: `b-${i}`, stream_id: 'agent:shared', correlation_id: 'agent:shared' }));

  const aSeen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = ctx.ledger.getStream(readerA, 'agent:shared', 5, cursor);
    for (const event of page.items) aSeen.add(event.event_id);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  assert.equal(aSeen.size, 12);
  assert.ok([...aSeen].every(id => id.startsWith('a-')), 'tenant A pagination must never surface tenant B events');

  const bPage = ctx.ledger.getStream(readerB, 'agent:shared', 50);
  assert.equal(bPage.items.length, 3);
  assert.ok(bPage.items.every(e => e.event_id.startsWith('b-')));
  assert.deepEqual(bPage.items.map(e => e.sequence), [1, 2, 3], 'tenant B stream has its own independent sequence');
});

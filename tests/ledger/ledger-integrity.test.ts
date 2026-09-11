import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { LedgerStore, Ledger, LedgerError } from '../../packages/ledger-core/src/index.js';
import { writerPrincipal, adminPrincipal } from '../../packages/ledger-core/src/index.js';
import { baseEvent } from './fixture.js';

function fileStore(): { path: string; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-ledger-integrity-'));
  return { path: resolve(dir, 'ledger.sqlite'), dir };
}

function tamperColumn(path: string, sequence: number, column: string, value: string): void {
  const raw = new DatabaseSync(path);
  const changes = raw.prepare(`UPDATE ledger_events SET ${column} = ? WHERE sequence = ?`).run(value, sequence);
  raw.close();
  assert.equal(changes.changes, 1, `tamper of ${column} must hit exactly one row`);
}

function seedThreeEvents(path: string, tenantId: string): void {
  const store = new LedgerStore(path);
  const ledger = new Ledger(store);
  const gw = writerPrincipal('ledger-writer-gate', tenantId, ['tna-gate']);
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e1' }));
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e2' }));
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e3' }));
  store.close();
}

for (const [label, column, value] of [
  ['payload tamper', 'payload', '{"tampered":true}'],
  ['event_type tamper', 'event_type', 'AGENT_REGISTERED_TAMPERED'],
  ['sequence tamper (event silently reassigned out of its stream, leaving a gap)', 'stream_id', 'agent:a-other'],
  ['previous-hash tamper', 'previous_event_hash', 'a'.repeat(64)],
  ['event-hash tamper', 'event_hash', 'b'.repeat(64)],
] as const) {
  test(`verifyStream detects ${label}`, () => {
    const { path, dir } = fileStore();
    const tenantId = 'tenant_demo';
    seedThreeEvents(path, tenantId);
    tamperColumn(path, 2, column, value);
    const store = new LedgerStore(path);
    const ledger = new Ledger(store);
    const ad = adminPrincipal('ledger-admin', tenantId);
    const result = ledger.verifyStream(ad, 'agent:a1');
    assert.equal(result.valid, false);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test('a corrupted stream blocks further writes (fail-closed)', () => {
  const { path, dir } = fileStore();
  const tenantId = 'tenant_demo';
  seedThreeEvents(path, tenantId);
  tamperColumn(path, 2, 'event_hash', 'c'.repeat(64));

  const store = new LedgerStore(path);
  const ledger = new Ledger(store);
  const gw = writerPrincipal('ledger-writer-gate', tenantId, ['tna-gate']);
  const ad = adminPrincipal('ledger-admin', tenantId);
  const verification = ledger.verifyStream(ad, 'agent:a1');
  assert.equal(verification.valid, false);

  assert.throws(() => ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'e4' })),
    (e: unknown) => e instanceof LedgerError && e.code === 'INTEGRITY_FAILURE');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('startup verification flags a stream whose head does not match its last persisted event', () => {
  const { path, dir } = fileStore();
  const tenantId = 'tenant_demo';
  seedThreeEvents(path, tenantId);
  // Tamper a field that feeds the head-event's own hash (not the event_hash column itself) so the
  // cheap startup recompute — which derives a hash from the row's other fields — disagrees with the
  // stream head's stored latest_event_hash.
  tamperColumn(path, 3, 'event_type', 'AGENT_REGISTERED_TAMPERED');

  const store = new LedgerStore(path);
  const head = store.streamHead(tenantId, 'agent:a1');
  assert.equal(head?.integrity_status, 'INVALID');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('verifyAll aggregates across streams and reports the first failure', () => {
  const { path, dir } = fileStore();
  const tenantId = 'tenant_demo';
  const store = new LedgerStore(path);
  const ledger = new Ledger(store);
  const gw = writerPrincipal('ledger-writer-gate', tenantId, ['tna-gate']);
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'clean-1', stream_id: 'agent:clean' }));
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'broken-1', stream_id: 'agent:broken' }));
  ledger.append(gw, baseEvent({ tenant_id: tenantId, event_id: 'broken-2', stream_id: 'agent:broken' }));
  store.close();
  tamperColumn(path, 2, 'event_type', 'TAMPERED');

  const reopened = new LedgerStore(path);
  const reopenedLedger = new Ledger(reopened);
  const ad = adminPrincipal('ledger-admin', tenantId);
  const summary = reopenedLedger.verifyAll(ad);
  assert.equal(summary.streamsChecked, 2);
  assert.equal(summary.validStreams, 1);
  assert.equal(summary.invalidStreams, 1);
  assert.equal(summary.firstFailure?.streamId, 'agent:broken');
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

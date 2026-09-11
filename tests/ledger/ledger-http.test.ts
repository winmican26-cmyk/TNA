import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { LedgerStore, Ledger } from '../../packages/ledger-core/src/index.js';
import { createLedgerServer, type LedgerCredentials } from '../../apps/tna-ledger/src/server.js';

function creds(): LedgerCredentials {
  return {
    writerGateToken: randomBytes(24).toString('hex'),
    writerVadToken: randomBytes(24).toString('hex'),
    readerToken: randomBytes(24).toString('hex'),
    adminToken: randomBytes(24).toString('hex'),
  };
}

interface Harness {
  base: string;
  credentials: LedgerCredentials;
  store: LedgerStore;
}

async function harness(t: TestContext, tenantId = 'tenant_demo', sharedStore?: LedgerStore, credentials = creds()): Promise<Harness> {
  const store = sharedStore ?? new LedgerStore(':memory:');
  const server = createLedgerServer(new Ledger(store), credentials, tenantId);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    if (!sharedStore) store.close();
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}`, credentials, store };
}

function jsonHeaders(token?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function post(base: string, path: string, token: string | undefined, body: unknown, rawBody?: string): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: jsonHeaders(token), body: rawBody ?? JSON.stringify(body) });
}
async function get(base: string, path: string, token?: string): Promise<Response> {
  return fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

function gateEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0', event_id: 'http-e1', event_type: 'AGENT_REGISTERED',
    tenant_id: 'tenant_demo', stream_id: 'agent:http-1', correlation_id: 'agent:http-1',
    actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate',
    authority_context: { agent_id: 'http-1' },
    ...overrides,
  };
}

test('HTTP: a valid ledger writer can append a valid event', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent());
  assert.equal(res.status, 201);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.event_id, 'http-e1');
  assert.ok(typeof body.event_hash === 'string' && body.event_hash.length === 64);
  assert.equal(body.sequence, 1);
});

test('HTTP: an anonymous request (no bearer) is rejected 401', async (t) => {
  const h = await harness(t);
  const res = await fetch(h.base + '/v1/ledger/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gateEvent()) });
  assert.equal(res.status, 401);
});

test('HTTP: an unrecognized bearer token is rejected 401', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', 'deadbeef'.repeat(8), gateEvent());
  assert.equal(res.status, 401);
});

test('HTTP: a reader credential cannot append (403)', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', h.credentials.readerToken, gateEvent({ event_id: 'http-reader' }));
  assert.equal(res.status, 403);
});

test('HTTP: a Gate writer cannot claim source_component vad-engine (403)', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'http-gate-imp', source_component: 'vad-engine' }));
  assert.equal(res.status, 403);
});

test('HTTP: a VAD writer cannot claim source_component tna-gate (403)', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', h.credentials.writerVadToken, gateEvent({ event_id: 'http-vad-imp' }));
  assert.equal(res.status, 403);
});

test('HTTP: malformed JSON body is rejected 400', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, undefined, '{ this is not json');
  assert.equal(res.status, 400);
});

test('HTTP: wrong content-type is rejected 415', async (t) => {
  const h = await harness(t);
  const res = await fetch(h.base + '/v1/ledger/events', { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${h.credentials.writerGateToken}` }, body: JSON.stringify(gateEvent()) });
  assert.equal(res.status, 415);
});

test('HTTP: unsupported event version is rejected 400', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'http-ver', version: '2.0' }));
  assert.equal(res.status, 400);
  const body = await res.json() as Record<string, unknown>;
  assert.ok(typeof body.error === 'string');
});

test('HTTP: unknown event type is rejected 400', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'http-type', event_type: 'NOT_A_REAL_EVENT_TYPE' }));
  assert.equal(res.status, 400);
});

test('HTTP: oversized payload is rejected 413', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'http-big', payload: { blob: 'x'.repeat(9000) } }));
  assert.equal(res.status, 413);
});

test('HTTP: a persisted event can be retrieved by id', async (t) => {
  const h = await harness(t);
  await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'http-get' }));
  const res = await get(h.base, '/v1/ledger/events/http-get', h.credentials.readerToken);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.event_id, 'http-get');
});

test('HTTP: an unknown event id returns 404', async (t) => {
  const h = await harness(t);
  const res = await get(h.base, '/v1/ledger/events/never-existed', h.credentials.readerToken);
  assert.equal(res.status, 404);
});

test('HTTP: reader can query events within its own tenant', async (t) => {
  const h = await harness(t);
  await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'http-q1' }));
  const res = await get(h.base, '/v1/ledger/streams/agent:http-1', h.credentials.readerToken);
  assert.equal(res.status, 200);
  const body = await res.json() as { items: Array<Record<string, unknown>>; nextCursor: string | null };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.event_id, 'http-q1');
});

test('HTTP: tenant A cannot read tenant B events', async (t) => {
  const store = new LedgerStore(':memory:');
  t.after(() => store.close());
  const a = await harness(t, 'tenant_a', store);
  const b = await harness(t, 'tenant_b', store);
  const appended = await post(a.base, '/v1/ledger/events', a.credentials.writerGateToken, gateEvent({ event_id: 'x-tenant', tenant_id: 'tenant_a' }));
  assert.equal(appended.status, 201);
  const res = await get(b.base, '/v1/ledger/streams/agent:http-1', b.credentials.readerToken);
  assert.equal(res.status, 200);
  const body = await res.json() as { items: unknown[] };
  assert.equal(body.items.length, 0);
});

test('HTTP: a tenant A writer cannot write an event declaring tenant_id tenant_b', async (t) => {
  const store = new LedgerStore(':memory:');
  t.after(() => store.close());
  const a = await harness(t, 'tenant_a', store);
  const res = await post(a.base, '/v1/ledger/events', a.credentials.writerGateToken, gateEvent({ event_id: 'x-tenant-w', tenant_id: 'tenant_b' }));
  assert.equal(res.status, 403);
});

test('HTTP: the stream endpoint uses bounded pagination with a working continuation cursor', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 15; i++) {
    const res = await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: `page-${String(i).padStart(2, '0')}`, stream_id: 'agent:http-page', correlation_id: 'agent:http-page' }));
    assert.equal(res.status, 201);
  }
  const first = await (await get(h.base, '/v1/ledger/streams/agent:http-page?limit=10', h.credentials.readerToken)).json() as { items: Array<{ event_id: string }>; nextCursor: string | null };
  assert.equal(first.items.length, 10);
  assert.ok(first.nextCursor);
  const second = await (await get(h.base, `/v1/ledger/streams/agent:http-page?limit=10&cursor=${encodeURIComponent(first.nextCursor as string)}`, h.credentials.readerToken)).json() as { items: Array<{ event_id: string }>; nextCursor: string | null };
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
  const ids = [...first.items, ...second.items].map(e => e.event_id);
  assert.equal(new Set(ids).size, 15);

  const bad = await get(h.base, '/v1/ledger/streams/agent:http-page?limit=0', h.credentials.readerToken);
  assert.equal(bad.status, 400);
  const badParam = await get(h.base, '/v1/ledger/streams/agent:http-page?bogus=1', h.credentials.readerToken);
  assert.equal(badParam.status, 400);
});

test('HTTP: the search endpoint uses bounded pagination', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 8; i++) {
    await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: `s-${i}`, stream_id: 'agent:http-s', correlation_id: 'agent:http-s' }));
  }
  const page = await (await get(h.base, '/v1/ledger/search?correlationId=agent:http-s&limit=3', h.credentials.readerToken)).json() as { items: unknown[]; nextCursor: string | null };
  assert.equal(page.items.length, 3);
  assert.ok(page.nextCursor);
});

test('HTTP: the stream integrity verification endpoint reports a clean stream', async (t) => {
  const h = await harness(t);
  await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'v1' }));
  await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'v2' }));
  const res = await get(h.base, '/v1/ledger/streams/agent:http-1/verify', h.credentials.readerToken);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.valid, true);
  assert.equal(body.eventsChecked, 2);
});

test('HTTP: the reconstruction endpoint reconstructs a Gate action', async (t) => {
  const h = await harness(t);
  const decisionId = 'dec-http-1';
  const gw = h.credentials.writerGateToken;
  await post(h.base, '/v1/ledger/events', gw, {
    version: '1.0', event_id: `${decisionId}.AUTHORIZATION_ALLOWED`, event_type: 'AUTHORIZATION_ALLOWED',
    tenant_id: 'tenant_demo', stream_id: 'agent:http-r', correlation_id: decisionId,
    actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate',
    authority_context: { agent_id: 'http-r', decision_id: decisionId, policy_hash: 'p1', action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.release' },
  });
  await post(h.base, '/v1/ledger/events', gw, {
    version: '1.0', event_id: `${decisionId}.EXECUTION_STARTED.exec-r`, event_type: 'EXECUTION_STARTED',
    tenant_id: 'tenant_demo', stream_id: 'agent:http-r', correlation_id: decisionId,
    actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker',
    execution_context: { execution_id: 'exec-r', tool: 'deploy.execute', resource: 'prod.release' },
  });
  await post(h.base, '/v1/ledger/events', gw, {
    version: '1.0', event_id: `${decisionId}.EXECUTION_SUCCEEDED.exec-r`, event_type: 'EXECUTION_SUCCEEDED',
    tenant_id: 'tenant_demo', stream_id: 'agent:http-r', correlation_id: decisionId,
    actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker',
    execution_context: { execution_id: 'exec-r', result_hash: 'a'.repeat(64) },
  });
  const res = await get(h.base, `/v1/ledger/reconstruct?type=gate&correlationId=${decisionId}`, h.credentials.readerToken);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.what, 'production.deploy');
  assert.equal(body.outcome, 'SUCCEEDED');
  assert.equal((body.execution as Record<string, unknown> | null)?.executionId, 'exec-r');
});

for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
  test(`HTTP: the ordinary API exposes no ${method} route for events (404)`, async (t) => {
    const h = await harness(t);
    await post(h.base, '/v1/ledger/events', h.credentials.writerGateToken, gateEvent({ event_id: 'immutable-1' }));
    const res = await fetch(h.base + '/v1/ledger/events/immutable-1', { method, headers: { Authorization: `Bearer ${h.credentials.adminToken}` } });
    assert.equal(res.status, 404);
    // and the event is untouched
    const still = await get(h.base, '/v1/ledger/events/immutable-1', h.credentials.readerToken);
    assert.equal(still.status, 200);
  });
}

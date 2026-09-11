import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { hash } from '../../packages/sentinel-schema/src/index.js';
import { SentinelRuntime, adminPrincipal } from '../../packages/sentinel-runtime/src/index.js';
import { createSentinelServer, type SentinelCredentials } from '../../apps/tna-sentinel/src/server.js';

function creds(): SentinelCredentials {
  return {
    observerGateToken: randomBytes(24).toString('hex'), observerBrokerToken: randomBytes(24).toString('hex'),
    observerIsolationToken: randomBytes(24).toString('hex'), observerEgressToken: randomBytes(24).toString('hex'),
    observerSecretBrokerToken: randomBytes(24).toString('hex'), observerToolAdapterToken: randomBytes(24).toString('hex'),
    observerVadToken: randomBytes(24).toString('hex'), observerSystemToken: randomBytes(24).toString('hex'),
    readerToken: randomBytes(24).toString('hex'), controllerToken: randomBytes(24).toString('hex'), adminToken: randomBytes(24).toString('hex'),
  };
}

interface Harness { base: string; credentials: SentinelCredentials; runtime: SentinelRuntime }

async function harness(t: TestContext, tenantId = 'tenant_demo', credentials = creds()): Promise<Harness> {
  const runtime = new SentinelRuntime(':memory:');
  runtime.installDefaultPolicy(adminPrincipal('sentinel-admin', tenantId));
  const server = createSentinelServer(runtime, credentials, tenantId);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    runtime.close();
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}`, credentials, runtime };
}

function jsonHeaders(token?: string): Record<string, string> { return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }
async function post(base: string, path: string, token: string | undefined, body: unknown, rawBody?: string): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: jsonHeaders(token), body: rawBody ?? JSON.stringify(body) });
}
async function get(base: string, path: string, token?: string): Promise<Response> { return fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); }

function sessionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0', tenant_id: 'tenant_demo', agent_id: 'http-agent-1', execution_id: `exec-${Math.random().toString(36).slice(2)}`,
    correlation_id: 'decision-1', authority_snapshot_hash: hash('authority-v1'), policy_snapshot_hash: hash('policy-v1'),
    expected_action: 'production.deploy', expected_tool: 'github', expected_resource: 'repo:company/app',
    allowed_destinations: ['api.github.com'], allowed_operations: ['read', 'write'],
    authority_expiry: new Date(Date.now() + 3600_000).toISOString(), runtime_limits: { max_runtime_seconds: 3600 }, cost_limits: { max_cost_usd: 10 },
    ...overrides,
  };
}
async function createSession(h: Harness, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await post(h.base, '/v1/sentinel/sessions', h.credentials.controllerToken, sessionInput(overrides));
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return res.json() as Promise<Record<string, unknown>>;
}

test('HTTP: an anonymous request (no bearer) is rejected 401', async (t) => {
  const h = await harness(t);
  const res = await fetch(h.base + '/v1/sentinel/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sessionInput()) });
  assert.equal(res.status, 401);
});
test('HTTP: an unrecognized bearer token is rejected 401', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/sentinel/sessions', 'deadbeef'.repeat(8), sessionInput());
  assert.equal(res.status, 401);
});

test('HTTP: a controller can create a session and a reader can read it', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  const res = await get(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}`, h.credentials.readerToken);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.status, 'MONITORING');
});
test('HTTP: a reader cannot create a session (403)', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/sentinel/sessions', h.credentials.readerToken, sessionInput());
  assert.equal(res.status, 403);
});
test('HTTP: cross-tenant reader cannot see another tenant\'s session', async (t) => {
  const h = await harness(t, 'tenant_a');
  const session = await createSession(h, { tenant_id: 'tenant_a' });
  const otherCreds = creds();
  const other = await harness(t, 'tenant_b', otherCreds);
  const res = await get(other.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}`, otherCreds.readerToken);
  assert.equal(res.status, 404);
});

test('HTTP: a bound observer can submit an allowed observation', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  const res = await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/observations`, h.credentials.observerBrokerToken, {
    version: '1.0', observation_id: 'obs-1', tenant_id: 'tenant_demo', sentinel_session_id: session.sentinel_session_id,
    timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github' },
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { decision: { decision: string } | null };
  assert.equal(body.decision?.decision, 'CONTINUE');
});
test('HTTP: an observer submitting a type it is not bound to is rejected 403', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  const res = await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/observations`, h.credentials.observerBrokerToken, {
    version: '1.0', observation_id: 'obs-2', tenant_id: 'tenant_demo', sentinel_session_id: session.sentinel_session_id,
    timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'NETWORK_REQUEST', payload: { destination: 'evil.example.com' },
  });
  assert.equal(res.status, 403);
});
test('HTTP: a reader cannot submit an observation (403)', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  const res = await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/observations`, h.credentials.readerToken, {
    version: '1.0', observation_id: 'obs-3', tenant_id: 'tenant_demo', sentinel_session_id: session.sentinel_session_id,
    timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github' },
  });
  assert.equal(res.status, 403);
});
test('HTTP: an unknown observation type is rejected 400', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  const res = await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/observations`, h.credentials.observerBrokerToken, {
    version: '1.0', observation_id: 'obs-4', tenant_id: 'tenant_demo', sentinel_session_id: session.sentinel_session_id,
    timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'NOT_A_REAL_TYPE',
  });
  assert.equal(res.status, 400);
});
test('HTTP: an oversized observation payload is rejected 413', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  const res = await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/observations`, h.credentials.observerBrokerToken, {
    version: '1.0', observation_id: 'obs-5', tenant_id: 'tenant_demo', sentinel_session_id: session.sentinel_session_id,
    timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED', payload: { blob: 'x'.repeat(9000) },
  });
  assert.equal(res.status, 413);
});
test('HTTP: malformed JSON body is rejected 400', async (t) => {
  const h = await harness(t);
  const res = await post(h.base, '/v1/sentinel/sessions', h.credentials.controllerToken, undefined, '{ not json');
  assert.equal(res.status, 400);
});
test('HTTP: wrong content-type is rejected 415', async (t) => {
  const h = await harness(t);
  const res = await fetch(h.base + '/v1/sentinel/sessions', { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${h.credentials.controllerToken}` }, body: JSON.stringify(sessionInput()) });
  assert.equal(res.status, 415);
});

test('HTTP: a runtime violation (tool drift) surfaces over the violations endpoint', async (t) => {
  const h = await harness(t);
  const session = await createSession(h, { expected_tool: 'github' });
  await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/observations`, h.credentials.observerBrokerToken, {
    version: '1.0', observation_id: 'drift-1', tenant_id: 'tenant_demo', sentinel_session_id: session.sentinel_session_id,
    timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' },
  });
  const violations = await (await get(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/violations`, h.credentials.readerToken)).json() as { items: Array<{ rule_type: string }> };
  assert.equal(violations.items[0]?.rule_type, 'TOOL_NOT_ALLOWED');
  const decisions = await (await get(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/decisions`, h.credentials.readerToken)).json() as { items: Array<{ decision: string }> };
  assert.equal(decisions.items[0]?.decision, 'TERMINATE');
  const finalSession = await (await get(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}`, h.credentials.readerToken)).json() as { status: string };
  assert.equal(finalSession.status, 'TERMINATED');
});

test('HTTP: a controller can hold and terminate a session', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  const held = await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/hold`, h.credentials.controllerToken, { message: 'manual review' });
  assert.equal(held.status, 200);
  assert.equal((await held.json() as { status: string }).status, 'HELD');
  const other = await createSession(h);
  const terminated = await post(h.base, `/v1/sentinel/sessions/${String(other.sentinel_session_id)}/terminate`, h.credentials.controllerToken, { message: 'shut it down' });
  assert.equal(terminated.status, 200);
  assert.equal((await terminated.json() as { status: string }).status, 'TERMINATED');
});
test('HTTP: a reader cannot hold or terminate a session (403)', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  assert.equal((await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/hold`, h.credentials.readerToken, { message: 'x' })).status, 403);
  assert.equal((await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/terminate`, h.credentials.readerToken, { message: 'x' })).status, 403);
});
test('HTTP: an agent-equivalent (reader) credential cannot resume a HELD session', async (t) => {
  const h = await harness(t);
  const session = await createSession(h);
  await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/hold`, h.credentials.controllerToken, { message: 'review' });
  const res = await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/resume`, h.credentials.readerToken, { rationale: 'self-resume attempt' });
  assert.equal(res.status, 403);
  const okResume = await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/resume`, h.credentials.controllerToken, { rationale: 'reviewed' });
  assert.equal(okResume.status, 200);
});

test('HTTP: an admin can activate an emergency stop; a controller cannot', async (t) => {
  const h = await harness(t);
  const admin = await post(h.base, '/v1/sentinel/stops', h.credentials.adminToken, { scopeType: 'tenant', scopeValue: 'tenant_demo', reason: 'incident' });
  assert.equal(admin.status, 201);
  const nonAdmin = await post(h.base, '/v1/sentinel/stops', h.credentials.controllerToken, { scopeType: 'tenant', scopeValue: 'tenant_demo', reason: 'incident' });
  assert.equal(nonAdmin.status, 403);
});
test('HTTP: releasing a stop works through its own explicit endpoint, and stops list is readable', async (t) => {
  const h = await harness(t);
  await post(h.base, '/v1/sentinel/stops', h.credentials.adminToken, { scopeType: 'session', scopeValue: 'some-session', reason: 'temp' });
  const release = await post(h.base, '/v1/sentinel/stops/release', h.credentials.adminToken, { scopeType: 'session', scopeValue: 'some-session' });
  assert.equal(release.status, 200);
  const list = await (await get(h.base, '/v1/sentinel/stops', h.credentials.readerToken)).json() as unknown[];
  assert.equal(Array.isArray(list), true);
});

test('HTTP: search/stream-style pagination on decisions and violations is bounded', async (t) => {
  const h = await harness(t);
  const session = await createSession(h, { expected_tool: 'github' });
  for (let i = 0; i < 3; i++) {
    await post(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/observations`, h.credentials.observerBrokerToken, {
      version: '1.0', observation_id: `d-${i}`, tenant_id: 'tenant_demo', sentinel_session_id: session.sentinel_session_id,
      timestamp: new Date().toISOString(), source: 'EXECUTION_BROKER', observation_type: 'COST_REPORTED', payload: { cost_usd: 0.01 },
    });
  }
  const bad = await get(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/decisions?limit=0`, h.credentials.readerToken);
  assert.equal(bad.status, 400);
  const badParam = await get(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/decisions?bogus=1`, h.credentials.readerToken);
  assert.equal(badParam.status, 400);
  const page = await (await get(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}/decisions?limit=2`, h.credentials.readerToken)).json() as { items: unknown[]; nextCursor: string | null };
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
});

for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
  test(`HTTP: the ordinary API exposes no ${method} route for a session (404) — mutation only ever happens through named action endpoints`, async (t) => {
    const h = await harness(t);
    const session = await createSession(h);
    const res = await fetch(`${h.base}/v1/sentinel/sessions/${String(session.sentinel_session_id)}`, { method, headers: { Authorization: `Bearer ${h.credentials.adminToken}` } });
    assert.equal(res.status, 404);
    const still = await get(h.base, `/v1/sentinel/sessions/${String(session.sentinel_session_id)}`, h.credentials.readerToken);
    assert.equal(still.status, 200);
  });
}

test('credential separation rejects short and duplicate credentials', () => {
  const runtime = new SentinelRuntime(':memory:');
  try {
    const bad = creds();
    assert.throws(() => createSentinelServer(runtime, { ...bad, readerToken: 'short' }, 'tenant_demo'));
    assert.throws(() => createSentinelServer(runtime, { ...bad, controllerToken: bad.readerToken }, 'tenant_demo'));
  } finally { runtime.close(); }
});

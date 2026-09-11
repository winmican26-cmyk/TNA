import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../../packages/execution-broker/src/index.js';
import { Ledger, LedgerStore } from '../../packages/ledger-core/src/index.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory, readerPrincipal as sentinelReaderPrincipal } from '../../packages/sentinel-runtime/src/index.js';
import { AuditorRuntime, adminPrincipal as auditorAdmin } from '../../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../../packages/auditor-evidence/src/index.js';
import { PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformStore, type GatePort } from '../../packages/platform-core/src/index.js';
import { buildPlatformMetrics } from '../../packages/deployment-health/src/index.js';
import { createPlatformServer } from '../../apps/tna-platform/src/server.js';
import { NOW, envelope } from '../fixture.js';

const TENANT = 'tenant_health';
const AGENT = 'deployment-agent-17'; // must match the agent id baked into tests/fixture.ts's envelope()
const CREDENTIALS = {
  agentTokens: { [`agent-token-${'a'.repeat(24)}`]: AGENT },
  operatorToken: 'operator-token-32-characters-long-x',
  adminToken: 'admin-token-32-characters-long-xxxx',
  serviceToken: 'service-token-32-characters-long-xx',
};
const AGENT_TOKEN = Object.keys(CREDENTIALS.agentTokens)[0]!;
function headers(token: string): Record<string, string> { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }

async function withServer(opts: { auditorDown?: boolean; sentinelDown?: boolean } = {}, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-health-http-'));
  const gateEvidence = new Store(':memory:');
  const gate = new Gate(gateEvidence, () => NOW);
  gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT, name: 'Health Agent' });
  gate.setEnvelope({ kind: 'admin', role: 'administrator' }, envelope());
  const registry = new ToolRegistry();
  registry.register({ name: 'log.write', action: 'log.write', resourceType: 'files', allowedOperations: ['read'], networkRequired: false, credentialsRequired: [], handler: context => ({ echoed: context.input }) });
  const broker = new ExecutionBroker(gateEvidence, new CapabilityCodec(randomBytes(32)), registry);
  const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
  const ledgerStore = new LedgerStore(':memory:');
  const ledger = new Ledger(ledgerStore);
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
  const gatePort: GatePort = { authorize: (principal, request) => gate.authorize(principal, request) };
  const gateOrchestrator = new PlatformGateOrchestrator(platform, gatePort);
  const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController('c', TENANT), sentinelObserverFactory('o', TENANT, ['EXECUTION_BROKER']));
  const control = new PlatformControlOrchestrator(platform);
  const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
  const auditorProvider = new LedgerEvidenceProvider(ledger, { readerId: 'r' });
  const auditorRuntime = new AuditorRuntime(':memory:', { evidenceProvider: auditorProvider });
  if (opts.auditorDown) auditorRuntime.close(); // a closed store makes every subsequent read throw — genuine unavailability, not a stub
  const metrics = buildPlatformMetrics();
  const sentinelHealthPrincipal = sentinelReaderPrincipal('health-probe', TENANT);
  const server = createPlatformServer({
    store: platform, facade, control, auditor: { runtime: auditorRuntime, principal: auditorAdmin('a', TENANT) },
    health: { store: platform, tenantId: TENANT, gate, sentinel: opts.sentinelDown ? (() => { sentinel.close(); return sentinel; })() : sentinel, sentinelHealthPrincipal, ledgerStore, auditor: { runtime: auditorRuntime, principal: auditorAdmin('a', TENANT) } },
    metrics, configHash: 'test-config-hash', deploymentId: 'dep_test',
  }, CREDENTIALS, TENANT);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try { await run(`http://127.0.0.1:${port}`); }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    platform.close(); gateEvidence.close(); try { sentinel.close(); } catch { /* already closed */ } ledgerStore.close(); try { auditorRuntime.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('GET /live requires no credential and reports live with uptime', async () => {
  await withServer({}, async baseUrl => {
    const res = await fetch(`${baseUrl}/live`);
    assert.equal(res.status, 200);
    const body = await res.json() as { live: boolean; uptime_seconds: number };
    assert.equal(body.live, true);
    assert.ok(body.uptime_seconds >= 0);
  });
});

test('GET /ready requires no credential and reports ready when all mandatory dependencies are healthy', async () => {
  await withServer({}, async baseUrl => {
    const res = await fetch(`${baseUrl}/ready`);
    assert.equal(res.status, 200);
    const body = await res.json() as { ready: boolean; status: string; components: { component: string; mandatory: boolean; status: string }[] };
    assert.equal(body.ready, true);
    assert.ok(body.components.some(c => c.component === 'platform_store'));
  });
});

test('GET /ready reports DEGRADED-but-ready when only the optional Auditor is unavailable', async () => {
  await withServer({ auditorDown: true }, async baseUrl => {
    const res = await fetch(`${baseUrl}/ready`);
    assert.equal(res.status, 200, 'ordinary execution readiness must not require the post-hoc Auditor');
    const body = await res.json() as { ready: boolean; status: string; components: { component: string; status: string }[] };
    assert.equal(body.ready, true);
    assert.equal(body.status, 'DEGRADED');
    assert.ok(body.components.some(c => c.component === 'auditor' && c.status === 'UNAVAILABLE'));
  });
});

test('GET /ready reports NOT READY (503) when a mandatory dependency (Sentinel) is unavailable', async () => {
  await withServer({ sentinelDown: true }, async baseUrl => {
    const res = await fetch(`${baseUrl}/ready`);
    assert.equal(res.status, 503, 'a mandatory dependency outage must fail readiness closed, not report healthy');
    const body = await res.json() as { ready: boolean };
    assert.equal(body.ready, false);
  });
});

test('GET /diagnostics requires an admin/service credential, never an agent credential, and leaks no secret', async () => {
  await withServer({}, async baseUrl => {
    const denied = await fetch(`${baseUrl}/diagnostics`, { headers: headers(AGENT_TOKEN) });
    assert.equal(denied.status, 403);
    const anon = await fetch(`${baseUrl}/diagnostics`);
    assert.equal(anon.status, 401);
    const allowed = await fetch(`${baseUrl}/diagnostics`, { headers: headers(CREDENTIALS.adminToken) });
    assert.equal(allowed.status, 200);
    const body = await allowed.json() as Record<string, unknown>;
    assert.equal(body.config_hash, 'test-config-hash');
    assert.equal(body.deployment_id, 'dep_test');
    const serialized = JSON.stringify(body);
    for (const secret of Object.values(CREDENTIALS).flatMap(v => typeof v === 'string' ? [v] : Object.keys(v))) {
      assert.ok(!serialized.includes(secret), `diagnostics output must never contain the credential ${secret}`);
    }
  });
});

test('GET /metrics requires an admin/service credential and renders label-free Prometheus text', async () => {
  await withServer({}, async baseUrl => {
    const denied = await fetch(`${baseUrl}/metrics`, { headers: headers(AGENT_TOKEN) });
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${baseUrl}/metrics`, { headers: headers(CREDENTIALS.serviceToken) });
    assert.equal(allowed.status, 200);
    const text = await allowed.text();
    assert.ok(text.includes('actions_received_total'));
    assert.ok(!/\{.*\}/.test(text), 'metric lines must carry no label set — bounded cardinality');
  });
});

test('GET /v1/platform/outbox/dead-letters requires an admin/service credential', async () => {
  await withServer({}, async baseUrl => {
    const denied = await fetch(`${baseUrl}/v1/platform/outbox/dead-letters`, { headers: headers(AGENT_TOKEN) });
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${baseUrl}/v1/platform/outbox/dead-letters`, { headers: headers(CREDENTIALS.adminToken) });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), []);
  });
});

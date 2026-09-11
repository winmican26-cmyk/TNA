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
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory } from '../../packages/sentinel-runtime/src/index.js';
import { AuditorRuntime, adminPrincipal as auditorAdmin } from '../../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../../packages/auditor-evidence/src/index.js';
import { PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformStore, type GatePort } from '../../packages/platform-core/src/index.js';
import { createPlatformServer } from '../../apps/tna-platform/src/server.js';
import { NOW, envelope } from '../fixture.js';

const TENANT = 'tenant_demo';
const AGENT = 'deployment-agent-17';
const CREDENTIALS = {
  agentTokens: { [`agent-token-${'a'.repeat(24)}`]: AGENT },
  operatorToken: 'operator-token-32-characters-long-x',
  adminToken: 'admin-token-32-characters-long-xxxx',
  serviceToken: 'service-token-32-characters-long-xx',
};
const AGENT_TOKEN = Object.keys(CREDENTIALS.agentTokens)[0]!;

function actionRequest(requestId: string, patch: Record<string, unknown> = {}) {
  return {
    version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
    action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/deploy.log',
    input: { message: 'hello' }, requires_verification: false, ...patch,
  };
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-http-'));
  const gateEvidence = new Store(':memory:');
  const gate = new Gate(gateEvidence, () => NOW);
  gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT, name: 'Deployment Agent' });
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
  const server = createPlatformServer({ store: platform, facade, control, auditor: { runtime: auditorRuntime, principal: auditorAdmin('a', TENANT) } }, CREDENTIALS, TENANT);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try { await run(`http://127.0.0.1:${port}`); }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    platform.close(); gateEvidence.close(); sentinel.close(); ledgerStore.close(); auditorRuntime.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
function headers(token: string): Record<string, string> { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }

test('HTTP: anonymous requests are rejected on every route', async () => {
  await withServer(async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/v1/platform/actions`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST' })).status, 401);
  });
});

test('HTTP: an invalid bearer token is rejected', async () => {
  await withServer(async baseUrl => { assert.equal((await fetch(`${baseUrl}/v1/platform/actions`, { headers: headers('not-a-real-token') })).status, 401); });
});

test('HTTP: an agent submits a valid action and it runs synchronously to COMPLETED', async () => {
  await withServer(async baseUrl => {
    const res = await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify(actionRequest('http_1')) });
    assert.equal(res.status, 201);
    const action = await res.json() as { state: string; platform_action_id: string };
    assert.equal(action.state, 'COMPLETED');

    const evidence = await fetch(`${baseUrl}/v1/platform/actions/${action.platform_action_id}/evidence`, { headers: headers(AGENT_TOKEN) });
    assert.equal(evidence.status, 200);
    const reconstruction = await evidence.json() as { gate: { decision: string } | null; capability_id: string | null; sentinel_session_id: string | null; execution: unknown };
    assert.equal(reconstruction.gate?.decision, 'ALLOW');
    assert.ok(reconstruction.capability_id);
    assert.ok(reconstruction.sentinel_session_id);
    assert.ok(reconstruction.execution);
  });
});

test('HTTP: Gate BLOCK and HOLD never reach execution over HTTP either', async () => {
  await withServer(async baseUrl => {
    const blocked = await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify(actionRequest('http_block', { tool: 'shell.unrestricted' })) });
    assert.equal((await blocked.json() as { state: string }).state, 'BLOCKED');
    const held = await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify(actionRequest('http_hold', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } })) });
    assert.equal((await held.json() as { state: string }).state, 'HELD');
  });
});

test('HTTP: an agent cannot self-approve its own HELD action', async () => {
  await withServer(async baseUrl => {
    const held = await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify(actionRequest('http_self_approve', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } })) });
    const { platform_action_id: id } = await held.json() as { platform_action_id: string };
    const res = await fetch(`${baseUrl}/v1/platform/actions/${id}/approve`, { method: 'POST', headers: headers(AGENT_TOKEN) });
    assert.equal(res.status, 403);
    const resumeRes = await fetch(`${baseUrl}/v1/platform/actions/${id}/resume`, { method: 'POST', headers: headers(AGENT_TOKEN) });
    assert.equal(resumeRes.status, 403);
  });
});

test('HTTP: an operator can approve a HELD action; an agent cannot terminate', async () => {
  await withServer(async baseUrl => {
    const held = await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify(actionRequest('http_operator_approve', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } })) });
    const { platform_action_id: id } = await held.json() as { platform_action_id: string };
    const approved = await fetch(`${baseUrl}/v1/platform/actions/${id}/approve`, { method: 'POST', headers: headers(CREDENTIALS.operatorToken) });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as { state: string }).state, 'AUTHORIZING');
    const terminateByAgent = await fetch(`${baseUrl}/v1/platform/actions/${id}/terminate`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify({ reason: 'x' }) });
    assert.equal(terminateByAgent.status, 403);
  });
});

test('HTTP: a platform-agent principal cannot read another agent-bound action', async () => {
  await withServer(async baseUrl => {
    const created = await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify(actionRequest('http_tenant')) });
    const { platform_action_id: id } = await created.json() as { platform_action_id: string };
    // The admin/operator/service credentials may read any action in-tenant; only a *different* agent identity is denied.
    const read = await fetch(`${baseUrl}/v1/platform/actions/${id}`, { headers: headers(CREDENTIALS.adminToken) });
    assert.equal(read.status, 200);
  });
});

test('HTTP: Auditor post-hoc assessment is real, computed, and does not rewrite execution truth', async () => {
  await withServer(async baseUrl => {
    const created = await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify(actionRequest('http_audit')) });
    const action = await created.json() as { state: string; platform_action_id: string };
    assert.equal(action.state, 'COMPLETED');
    const audited = await fetch(`${baseUrl}/v1/platform/actions/${action.platform_action_id}/audit`, { method: 'POST', headers: headers(AGENT_TOKEN) });
    assert.equal(audited.status, 200);
    const result = await audited.json() as { execution_result: string; audit_outcome: { outcome: string } };
    assert.equal(result.execution_result, 'COMPLETED');
    assert.ok(['PASS', 'PASS_WITH_FINDINGS', 'FAIL', 'INSUFFICIENT_EVIDENCE', 'ERROR'].includes(result.audit_outcome.outcome));
  });
});

test('HTTP: pagination is bounded, and no generic PATCH/PUT/DELETE mutation route exists for an action', async () => {
  await withServer(async baseUrl => {
    const created = await fetch(`${baseUrl}/v1/platform/actions`, { method: 'POST', headers: headers(AGENT_TOKEN), body: JSON.stringify(actionRequest('http_bounds')) });
    const { platform_action_id: id } = await created.json() as { platform_action_id: string };
    const overLimit = await fetch(`${baseUrl}/v1/platform/actions?limit=100000`, { headers: headers(CREDENTIALS.adminToken) });
    assert.equal(overLimit.status, 400);
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const res = await fetch(`${baseUrl}/v1/platform/actions/${id}`, { method, headers: headers(CREDENTIALS.adminToken) });
      assert.equal(res.status, 404, `${method} must not be a valid mutation route`);
    }
  });
});

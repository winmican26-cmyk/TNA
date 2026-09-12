import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { execPath } from 'node:process';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { LedgerStore, Ledger } from '../../packages/ledger-core/src/index.js';
import { SentinelRuntime } from '../../packages/sentinel-runtime/src/index.js';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';
import { createImprovementGovernorServer } from '../../apps/tna-improvement-governor/src/server.js';
import type { AuthorityCeiling, CapabilityProfile, RequiredTestManifest } from '../../packages/improvement-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section K: real HTTP/TCP tests against the
 * actual packaged governor server (`createImprovementGovernorServer`) — real Gate, real Ledger, real
 * Sentinel, real ImprovementStore, real `fetch()` over a real TCP socket. No route handler is called
 * directly; every request in this file goes over the network.
 */

const TENANT = 'ten_http_test';
const ADMIN_TOKEN = 'improvement-governor-test-admin-token-32chars-min';
const FIXTURE_ROOT = resolve('improvement', 'fixtures', 'demo-agent');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolvePort(port)); });
    srv.on('error', reject);
  });
}

function readOnlyCeiling(overrides: Partial<AuthorityCeiling> = {}): AuthorityCeiling {
  return { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 60_000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [], ...overrides };
}
function readOnlyCapability(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [], ...overrides };
}
function manifest(): RequiredTestManifest {
  return { manifest_id: 'm1', manifest_version: 1, entries: [{ test_id: 't1', path: 'regression.mjs', content_hash: null, required: true, source: 'accepted' }], manifest_hash: 'h1' };
}

let baseUrl: string;
let dir: string;
let store: ImprovementStore, gateStore: Store, ledgerStore: LedgerStore, sentinel: SentinelRuntime;
let server: ReturnType<typeof createImprovementGovernorServer>;

before(async () => {
  dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-http-test-'));
  store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  gateStore = new Store(resolve(dir, 'gate.sqlite'));
  const gate = new Gate(gateStore);
  ledgerStore = new LedgerStore(resolve(dir, 'ledger.sqlite'));
  const ledger = new Ledger(ledgerStore);
  sentinel = new SentinelRuntime(resolve(dir, 'sentinel.sqlite'));
  const port = await freePort();
  server = createImprovementGovernorServer({
    store, gate, ledger, ledgerStore, sentinel, tenantId: TENANT, governorAgentId: 'improvement-governor-http-test',
    approverRole: 'improvement-approver', adminToken: ADMIN_TOKEN,
  });
  await new Promise<void>(resolvePort => server.listen(port, '127.0.0.1', resolvePort));
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>(resolvePort => server.close(() => resolvePort()));
  store.close(); gateStore.close(); ledgerStore.close(); sentinel.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function api(method: string, path: string, bodyObj?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
  });
  const json = await res.json() as Record<string, unknown>;
  return { status: res.status, json };
}

test('real TCP: /live and /ready report real, live status over a real socket', async () => {
  const live = await fetch(`${baseUrl}/live`);
  assert.equal(live.status, 200);
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json() as { ready: boolean }).ready, true);
});

test('real TCP: an invalid admin token is refused before any route logic runs', async () => {
  const res = await fetch(`${baseUrl}/v1/improvements`, { method: 'POST', headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
});

test('real TCP golden path: propose -> authorize -> build -> evaluate -> canary (with real approval) -> promote (with real approval), all over real HTTP against the real packaged governor', async () => {
  const created = await api('POST', '/v1/improvements', {
    systemId: 'sys_http_1', systemName: 'http-demo-agent', parentGenerationId: null, parentWorkspacePath: FIXTURE_ROOT,
    objective: 'improve routing accuracy', improvementClass: 'CLASS_1_CODE', allowedMutationPaths: ['router.mjs'],
    authorityCeiling: readOnlyCeiling(), candidateVersion: 'v1', createdBy: 'http-test',
    requiredBenchmarks: ['routing-accuracy'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const generationId = (created.json.generation as { generation_id: string }).generation_id;
  assert.equal((created.json.generation as { status: string }).status, 'PROPOSED');

  const authorized = await api('POST', `/v1/improvements/${generationId}/authorize`);
  assert.equal((authorized.json.generation as { status: string }).status, 'AUTHORIZED');
  assert.equal((authorized.json.decision as { decision: string }).decision, 'ALLOW');

  const built = await api('POST', `/v1/improvements/${generationId}/build`, {});
  assert.equal((built.json.generation as { status: string }).status, 'BUILT');
  assert.ok(typeof built.json.candidate_workspace === 'string' && (built.json.candidate_workspace as string).length > 0);

  const evaluated = await api('POST', `/v1/improvements/${generationId}/evaluate`, {
    regressionTestCommand: [execPath, 'regression.mjs'], benchmarks: [{ benchmarkId: 'routing-accuracy', command: [execPath, 'benchmark.mjs'], threshold: 0.0, parentScore: 0.75 }],
    parentCapabilityProfile: readOnlyCapability(), candidateCapabilityProfile: readOnlyCapability(), candidateAuthorityProfile: readOnlyCeiling(),
    requiredTestManifestBefore: manifest(), requiredTestManifestAfter: manifest(), evaluationProfileHash: 'http-test-eval-profile',
  });
  assert.equal(evaluated.status, 200, JSON.stringify(evaluated.json));
  assert.equal((evaluated.json.evaluation as { status: string }).status, 'PROMOTE', JSON.stringify(evaluated.json));
  assert.equal((evaluated.json.vad as { finalState: string }).finalState, 'ACCEPTED');
  assert.equal((evaluated.json.generation as { status: string }).status, 'EVALUATED');

  // Canary requires real approval — first attempt with no approvalId is HOLD, never a silent bypass.
  const canaryHeld = await api('POST', `/v1/improvements/${generationId}/canary`, {});
  assert.equal((canaryHeld.json.decision as { decision: string }).decision, 'HOLD');
  const canaryApproval = await api('POST', `/v1/improvements/${generationId}/approve`, { operation: 'start_canary' });
  const canaryApprovalId = (canaryApproval.json.approval as { approvalId: string }).approvalId;
  const canaryStarted = await api('POST', `/v1/improvements/${generationId}/canary`, { approvalId: canaryApprovalId });
  assert.equal((canaryStarted.json.decision as { decision: string }).decision, 'ALLOW');
  assert.equal((canaryStarted.json.generation as { status: string }).status, 'CANARY');
  assert.ok(typeof canaryStarted.json.sentinel_session_id === 'string');

  // Promotion requires its own, separate real approval.
  const promoteHeld = await api('POST', `/v1/improvements/${generationId}/promote`, {});
  assert.equal((promoteHeld.json.decision as { decision: string }).decision, 'HOLD');
  const promoteApproval = await api('POST', `/v1/improvements/${generationId}/approve`, { operation: 'promote' });
  const promoteApprovalId = (promoteApproval.json.approval as { approvalId: string }).approvalId;
  const promoted = await api('POST', `/v1/improvements/${generationId}/promote`, { approvalId: promoteApprovalId });
  assert.equal((promoted.json.generation as { status: string }).status, 'PROMOTED');

  const fetched = await api('GET', `/v1/improvements/${generationId}`);
  assert.equal((fetched.json as { status: string }).status, 'PROMOTED');

  const evidence = await api('GET', `/v1/improvements/${generationId}/evidence`);
  assert.equal((evidence.json.reconstruction as { finalState: string }).finalState, 'PROMOTED');
  assert.ok(['PASS', 'INSUFFICIENT_EVIDENCE'].includes((evidence.json.assessment as { overall: string }).overall), JSON.stringify(evidence.json.assessment));

  const lineage = await api('GET', `/v1/improvements/${generationId}/lineage`);
  assert.ok((lineage.json.nodes as unknown[]).some((n) => (n as { generationId: string }).generationId === generationId));
});

test('real TCP: an authority-escalating candidate is REJECTed over real HTTP, even with a perfect benchmark', async () => {
  const created = await api('POST', '/v1/improvements', {
    systemId: 'sys_http_2', systemName: 'http-demo-agent-2', parentGenerationId: null, parentWorkspacePath: FIXTURE_ROOT,
    objective: 'improve accuracy while requesting write access', improvementClass: 'CLASS_1_CODE', allowedMutationPaths: ['router.mjs'],
    authorityCeiling: readOnlyCeiling(), candidateVersion: 'v1', createdBy: 'http-test', requiredBenchmarks: ['routing-accuracy'],
  });
  const generationId = (created.json.generation as { generation_id: string }).generation_id;
  await api('POST', `/v1/improvements/${generationId}/authorize`);
  await api('POST', `/v1/improvements/${generationId}/build`, {});
  const evaluated = await api('POST', `/v1/improvements/${generationId}/evaluate`, {
    regressionTestCommand: [execPath, 'regression.mjs'], benchmarks: [{ benchmarkId: 'routing-accuracy', command: [execPath, 'benchmark.mjs'], threshold: 0.0, parentScore: 0.75 }],
    parentCapabilityProfile: readOnlyCapability(), candidateCapabilityProfile: readOnlyCapability(),
    candidateAuthorityProfile: readOnlyCeiling({ operations: ['read', 'write'] }), // the escalation attempt
    requiredTestManifestBefore: manifest(), requiredTestManifestAfter: manifest(), evaluationProfileHash: 'http-test-eval-profile',
  });
  assert.equal((evaluated.json.evaluation as { status: string }).status, 'REJECT');
  assert.equal((evaluated.json.generation as { status: string }).status, 'REJECTED');

  const evidence = await api('GET', `/v1/improvements/${generationId}/evidence`);
  assert.equal((evidence.json.assessment as { overall: string }).overall, 'FAIL');
});

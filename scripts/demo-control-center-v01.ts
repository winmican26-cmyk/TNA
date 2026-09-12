/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) demo — build-order items 7-9. Eight real
 * flows driven through the real packaged BFF (`createControlCenterServer`, serving the real compiled
 * frontend bundle) in front of real, in-process Platform/Client Gateway/Ledger/Auditor/Improvement
 * Governor stacks — the same real server factories every Volume 13 test in this repo uses.
 *
 * Fixture INPUTS are seeded directly against the real backends (a submitted action, a registered MCP
 * server, a proposed improvement generation) — real preconditions, not shortcuts. Every printed OUTCOME
 * below is read back through the real BFF's own HTTP routes and is exactly what the real backend computed;
 * nothing here hand-sets a final status. Flow 7 is deliberately narrated as what the real evidence actually
 * proves (an authority-escalation attempt short-circuited evaluation before any benchmark ran) rather than
 * the more dramatic "better successor rejected" phrasing the original kickoff brief used — the real
 * governor's fail-fast evaluator does not produce evidence for that stronger claim, and this demo does not
 * fabricate it. Flow 8 shows the real rollback verification outcome, whatever it is; it is never forced to
 * a clean success.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  startRealPlatform, startRealClientGateway, startRealLedger, startRealAuditor,
  startRealImprovementGovernor, submitAction,
} from '../tests/control-center/harness.js';
import { ControlCenterSessionStore } from '../apps/tna-control-center/src/session-store.js';
import { tenantRegistryFromEntries } from '../apps/tna-control-center/src/tenant-registry.js';
import { PlatformProxyClient } from '../apps/tna-control-center/src/platform-client.js';
import { ClientGatewayProxyClient } from '../apps/tna-control-center/src/client-gateway-client.js';
import { LedgerProxyClient } from '../apps/tna-control-center/src/ledger-client.js';
import { AuditorProxyClient } from '../apps/tna-control-center/src/auditor-client.js';
import { ImprovementGovernorProxyClient } from '../apps/tna-control-center/src/improvement-client.js';
import { createControlCenterServer } from '../apps/tna-control-center/src/server.js';

function flow(n: number, title: string): void { process.stdout.write(`\n--- Flow ${n}: ${title} ---\n`); }
function log(message: string): void { process.stdout.write(`  ${message}\n`); }

async function main(): Promise<void> {
  const clientGateway = await startRealClientGateway('demo_cc');
  const created = clientGateway.store.createTenant({ display_name: 'Demo Co', environment: 'test', deployment_binding: 'demo-dep', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] }, 'demo-admin');
  const TENANT = clientGateway.store.activateTenant(created.tenant_id, created.state_version).tenant_id;

  const platform = await startRealPlatform(TENANT, 'demo_cc_tenant');
  const ledger = await startRealLedger(TENANT, 'demo_cc_tenant');
  const auditor = await startRealAuditor(TENANT, 'demo_cc_tenant', ledger.ledger);
  const governor = await startRealImprovementGovernor(TENANT, 'demo_cc_tenant');

  const entry = {
    tenant_id: TENANT, platform_base_url: platform.baseUrl, platform_token: platform.agentToken, platform_operator_token: platform.operatorToken,
    ledger_base_url: ledger.baseUrl, ledger_reader_token: ledger.readerToken, ledger_admin_token: ledger.adminToken,
    auditor_base_url: auditor.baseUrl, auditor_token: auditor.readerToken,
    improvement_base_url: governor.baseUrl, improvement_admin_token: governor.adminToken,
  };
  const sessions = new ControlCenterSessionStore(':memory:');
  sessions.createUser(TENANT, 'demo-admin', 'a-real-demo-password-1234', 'client-admin');
  const server = createControlCenterServer({
    sessions, tenants: tenantRegistryFromEntries([entry]), platform: new PlatformProxyClient(), cookieSecure: false,
    staticRoot: resolve('apps', 'tna-control-center-web', 'dist'),
    clientGateway: { baseUrl: clientGateway.baseUrl, adminToken: clientGateway.adminToken }, clientGatewayClient: new ClientGatewayProxyClient(),
    ledger: new LedgerProxyClient(), auditor: new AuditorProxyClient(), improvement: new ImprovementGovernorProxyClient(),
    environment: 'staging',
  });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const loginRes = await fetch(`${baseUrl}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo-admin', password: 'a-real-demo-password-1234' }) });
  const setCookies = loginRes.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
  const csrfPair = setCookies.map(c => c.split(';')[0]!).find(c => c.startsWith('tna_cc_csrf='));
  const csrfToken = csrfPair ? csrfPair.split('=')[1]! : '';
  async function bff(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  }
  const mutateHeaders = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };

  // Flow 1: Overview -----------------------------------------------------------------------------
  flow(1, 'Overview');
  const staticRes = await fetch(`${baseUrl}/`);
  assert.equal(staticRes.status, 200, 'the real compiled frontend must actually be served');
  log(`real compiled frontend served: ${staticRes.status} ${staticRes.headers.get('content-type')}`);
  const dash = await bff('/api/dashboard');
  assert.equal(dash.status, 200);
  log(`real dashboard: assurance=${(dash.json.assurance as { status: string }).status}, total_known_actions=${dash.json.total_known_actions}`);

  // Flow 2: Governed action ------------------------------------------------------------------------
  flow(2, 'Governed action');
  const normal = await submitAction(platform, 'demo_req_normal', {}, TENANT);
  const normalId = (normal.body as { platform_action_id: string }).platform_action_id;
  const normalDetail = await bff(`/api/actions/${normalId}`);
  log(`real action ${normalId}: state=${normalDetail.json.state}`);

  // Flow 3: Blocked action -------------------------------------------------------------------------
  flow(3, 'Blocked action');
  const blocked = await submitAction(platform, 'demo_req_blocked', { tool: 'shell.unrestricted' }, TENANT);
  const blockedId = (blocked.body as { platform_action_id: string }).platform_action_id;
  const blockedDetail = await bff(`/api/actions/${blockedId}`);
  assert.equal(blockedDetail.json.state, 'BLOCKED', 'the real Gate decision, not a demo assumption');
  log(`real action ${blockedId}: state=${blockedDetail.json.state} (real Gate BLOCK)`);

  // Flow 4: Human approval --------------------------------------------------------------------------
  flow(4, 'Human approval');
  const held = await submitAction(platform, 'demo_req_held', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, TENANT);
  const heldId = (held.body as { platform_action_id: string }).platform_action_id;
  const heldBefore = await bff(`/api/actions/${heldId}`);
  assert.equal(heldBefore.json.state, 'HELD');
  log(`real action ${heldId}: state=${heldBefore.json.state} (awaiting approval)`);
  const approveRes = await fetch(`${baseUrl}/api/actions/${heldId}/approve`, { method: 'POST', headers: mutateHeaders });
  const heldAfter = await bff(`/api/actions/${heldId}`);
  log(`after real approval (HTTP ${approveRes.status}): state=${heldAfter.json.state}`);
  assert.notEqual(heldAfter.json.state, 'HELD', 'the real backend must have actually transitioned the action');

  // Flow 5: MCP schema drift ------------------------------------------------------------------------
  flow(5, 'MCP schema drift');
  const fixturePath = resolve('dist', 'scripts', 'fixtures', 'mcp-fixture-server.js');
  const regRes = await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT}/mcp-servers`, {
    method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Demo CRM', transport: 'stdio', executable: process.execPath, args: [fixturePath], env_allowlist: ['MCP_FIXTURE_MODE'], credential_ref: null }),
  });
  const mcpServer = await regRes.json() as { mcp_server_id: string };
  process.env.MCP_FIXTURE_MODE = 'normal';
  await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT}/mcp-servers/${mcpServer.mcp_server_id}/discover`, { method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}` } });
  const toolsBefore = await bff('/api/tools') as unknown as { status: number; json: readonly { tool_id: string; external_tool_name: string; state_version: number }[] };
  const lookupTool = (toolsBefore.json).find(t => t.external_tool_name === 'crm.lookup_customer')!;
  await fetch(`${baseUrl}/api/tools/${lookupTool.tool_id}/enable`, { method: 'POST', headers: mutateHeaders, body: JSON.stringify({ state_version: lookupTool.state_version, risk_class: 'MEDIUM', policy_id: 'demo-policy', allowed_operations: ['read'], resource_patterns: ['*'] }) });
  process.env.MCP_FIXTURE_MODE = 'schema-v2';
  await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT}/mcp-servers/${mcpServer.mcp_server_id}/discover`, { method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}` } });
  const toolsAfter = await bff('/api/tools') as unknown as { json: readonly { tool_id: string; review_status: string; enabled: boolean }[] };
  const drifted = toolsAfter.json.find(t => t.tool_id === lookupTool.tool_id)!;
  assert.equal(drifted.review_status, 'POLICY_REVIEW_REQUIRED');
  assert.equal(drifted.enabled, false);
  log(`real tool ${lookupTool.tool_id}: review_status=${drifted.review_status}, enabled=${drifted.enabled} (real backend-detected schema drift)`);

  // Flow 6: Recursive improvement promoted ------------------------------------------------------------
  flow(6, 'Recursive improvement promoted');
  const { promoteThroughPromotion } = await buildImprovementHelpers(governor, TENANT);
  const gen1 = await promoteThroughPromotion('baseline improvement', null);
  assert.equal(gen1.finalStatus, 'PROMOTED');
  const gen1Detail = await bff(`/api/improvements/${gen1.generationId}`);
  log(`real generation ${gen1.generationId}: status=${gen1Detail.json.status} (real Gate+VAD+Ledger-backed promotion)`);

  // Flow 7: Authority-expansion attempt rejected (evidence-honest — see file header) -------------------
  flow(7, 'Authority-expansion attempt rejected before benchmark evaluation');
  const gen2 = await promoteThroughPromotion('attempt to expand authority', gen1.generationId, { operations: ['read', 'write'] });
  assert.equal(gen2.finalStatus, 'REJECTED');
  const gen2Evidence = await bff(`/api/improvements/${gen2.generationId}/evidence`);
  const evaluated = (gen2Evidence.json.reconstruction as { evaluated: { reason: string; authority_within_ceiling: boolean } }).evaluated;
  log(`real generation ${gen2.generationId}: status=REJECTED`);
  log(`real evaluator reason: "${evaluated.reason}"`);
  log(`real authority_within_ceiling: ${evaluated.authority_within_ceiling}`);
  log('Honest framing: evaluation short-circuits at the authority-ceiling check before any benchmark runs.');
  log('The real evidence proves "candidate attempted authority expansion -> evaluation stopped -> REJECTED" —');
  log('it does NOT prove a benchmark was ever measured for this candidate, so that claim is not made.');

  // Flow 8: Rollback (real verification outcome, never forced) -----------------------------------------
  flow(8, 'Rollback');
  const gen3 = await promoteThroughPromotion('second real successor, no authority delta', gen1.generationId);
  assert.equal(gen3.finalStatus, 'PROMOTED');
  const approveRollback = await fetch(`${baseUrl}/api/improvements/${gen3.generationId}/approve`, { method: 'POST', headers: mutateHeaders, body: JSON.stringify({ operation: 'rollback' }) });
  const approveRollbackBody = await approveRollback.json() as { approval: { approvalId: string } };
  const rollbackRes = await fetch(`${baseUrl}/api/improvements/${gen3.generationId}/rollback`, { method: 'POST', headers: mutateHeaders, body: JSON.stringify({ targetGenerationId: gen1.generationId, approvalId: approveRollbackBody.approval.approvalId }) });
  const rollbackBody = await rollbackRes.json() as { verified: boolean; generation: { status: string } };
  log(`real rollback verification: verified=${rollbackBody.verified}`);
  log(`real resulting generation status: ${rollbackBody.generation.status} (shown exactly as the backend computed it — never forced to a clean success)`);
  assert.ok(rollbackBody.generation.status === 'ROLLED_BACK' || rollbackBody.generation.status === 'INDETERMINATE', 'rollback must land on a real, backend-determined terminal state');

  process.stdout.write('\nAll 8 demo flows completed against real backends. Exit 0.\n');
  await new Promise<void>(res => server.close(() => res()));
  await governor.close(); await auditor.close(); await ledger.close(); await platform.close(); await clientGateway.close();
}

async function buildImprovementHelpers(governor: { baseUrl: string; adminToken: string }, tenantId: string) {
  const FIXTURE_ROOT = resolve('improvement', 'fixtures', 'demo-agent');
  const systemId = `sys_demo_${tenantId}`;
  function readOnlyCeiling(overrides: Record<string, unknown> = {}) {
    return { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 60_000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [], ...overrides };
  }
  function readOnlyCapability() {
    return { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [] };
  }
  function manifest() {
    return { manifest_id: 'm1', manifest_version: 1, entries: [{ test_id: 't1', path: 'regression.mjs', content_hash: null, required: true, source: 'accepted' }], manifest_hash: 'h1' };
  }
  async function api(method: string, path: string, bodyObj?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${governor.baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${governor.adminToken}` }, ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}) });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  }
  async function promoteThroughPromotion(objective: string, parentGenerationId: string | null, authorityOverrides: Record<string, unknown> = {}): Promise<{ generationId: string; finalStatus: string }> {
    const created = await api('POST', '/v1/improvements', {
      systemId, systemName: systemId, parentGenerationId, parentWorkspacePath: FIXTURE_ROOT,
      objective, improvementClass: 'CLASS_1_CODE', allowedMutationPaths: ['router.mjs'],
      authorityCeiling: readOnlyCeiling(), candidateVersion: 'v1', createdBy: 'demo', requiredBenchmarks: ['routing-accuracy'],
    });
    const generationId = (created.json.generation as { generation_id: string }).generation_id;
    await api('POST', `/v1/improvements/${generationId}/authorize`);
    await api('POST', `/v1/improvements/${generationId}/build`, {});
    const evaluated = await api('POST', `/v1/improvements/${generationId}/evaluate`, {
      regressionTestCommand: [process.execPath, 'regression.mjs'], benchmarks: [{ benchmarkId: 'routing-accuracy', command: [process.execPath, 'benchmark.mjs'], threshold: 0.0, parentScore: 0.75 }],
      parentCapabilityProfile: readOnlyCapability(), candidateCapabilityProfile: readOnlyCapability(),
      candidateAuthorityProfile: readOnlyCeiling(authorityOverrides),
      requiredTestManifestBefore: manifest(), requiredTestManifestAfter: manifest(), evaluationProfileHash: `demo-${systemId}`,
    });
    const finalStatus = (evaluated.json.evaluation as { status: string }).status;
    if (finalStatus !== 'PROMOTE') return { generationId, finalStatus: (evaluated.json.generation as { status: string }).status };
    const canaryApproval = await api('POST', `/v1/improvements/${generationId}/approve`, { operation: 'start_canary' });
    await api('POST', `/v1/improvements/${generationId}/canary`, { approvalId: (canaryApproval.json.approval as { approvalId: string }).approvalId });
    const promoteApproval = await api('POST', `/v1/improvements/${generationId}/approve`, { operation: 'promote' });
    const promoted = await api('POST', `/v1/improvements/${generationId}/promote`, { approvalId: (promoteApproval.json.approval as { approvalId: string }).approvalId });
    return { generationId, finalStatus: (promoted.json.generation as { status: string }).status };
  }
  return { promoteThroughPromotion, systemId };
}

main().catch(error => { process.stderr.write(`Demo failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exit(1); });

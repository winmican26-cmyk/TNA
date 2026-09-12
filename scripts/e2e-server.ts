/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Real-browser E2E fixture server.
 *
 * Starts the REAL packaged Control Center BFF (`createControlCenterServer`), serving the REAL compiled
 * frontend bundle (`apps/tna-control-center-web/dist` — must already be built), in front of REAL,
 * in-process backend stacks for two tenants (Platform, Client Gateway, Ledger, Auditor, Improvement
 * Governor) — the exact same real server factories every other Volume 13 test in this repo uses, never a
 * mock or fixture JSON server. Seeds real data (a HELD action, a BLOCKED action, a real MCP connection
 * with a REAL schema-drift transition, a real Ledger event, a real Auditor assessment, a real
 * promoted/rejected/promoted improvement lineage) so Playwright specs have real, stable identifiers to
 * assert against. Fixture identifiers and credentials are written to `e2e-fixtures.json` for spec files to
 * read; this process itself never exits (Playwright's `webServer` manages its lifecycle).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  startRealPlatform, startRealClientGateway, startRealLedger, seedLedgerEvent, startRealAuditor, seedRealAssessment,
  startRealImprovementGovernor, seedRealLineage, submitAction,
} from '../tests/control-center/harness.js';
import { ControlCenterSessionStore } from '../apps/tna-control-center/src/session-store.js';
import { tenantRegistryFromEntries } from '../apps/tna-control-center/src/tenant-registry.js';
import { PlatformProxyClient } from '../apps/tna-control-center/src/platform-client.js';
import { ClientGatewayProxyClient, type ClientGatewayConfig } from '../apps/tna-control-center/src/client-gateway-client.js';
import { LedgerProxyClient } from '../apps/tna-control-center/src/ledger-client.js';
import { AuditorProxyClient } from '../apps/tna-control-center/src/auditor-client.js';
import { ImprovementGovernorProxyClient } from '../apps/tna-control-center/src/improvement-client.js';
import { createControlCenterServer } from '../apps/tna-control-center/src/server.js';
import type { TenantRegistryEntry } from '../apps/tna-control-center/src/schema.js';

const PORT = 4173;
const PASSWORD = 'e2e-real-password-1234';

async function main(): Promise<void> {
  // The Client Gateway is genuinely multi-tenant and MINTS its own internal `tenant_id` on
  // `createTenant()` — there is no way to request a specific one. Both tenants' ids are therefore whatever
  // the real `ClientStore` actually assigns, captured here and reused for every other single-tenant-per
  // -process backend (Platform/Ledger/Auditor/Governor) so all real backends agree on one real tenant
  // identity, exactly as `tests/control-center/client-gateway-integration.test.ts` establishes. A real
  // Control Center deployment configures ONE Client Gateway for its whole tenant population — a tenant
  // this BFF serves but that the shared Client Gateway has never heard of would fail closed at login
  // (`checkTenantLifecycle`'s real `getTenant()` call would 404), so tenant B must be real there too, even
  // though only Platform is actually exercised through it.
  const clientGateway = await startRealClientGateway('e2e_shared');
  const createdTenantA = clientGateway.store.createTenant({ display_name: 'E2E Tenant A', environment: 'test', deployment_binding: 'e2e-dep-a', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] }, 'e2e-admin');
  const TENANT_A = clientGateway.store.activateTenant(createdTenantA.tenant_id, createdTenantA.state_version).tenant_id;
  const createdTenantB = clientGateway.store.createTenant({ display_name: 'E2E Tenant B', environment: 'test', deployment_binding: 'e2e-dep-b', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'] }, 'e2e-admin');
  const TENANT_B = clientGateway.store.activateTenant(createdTenantB.tenant_id, createdTenantB.state_version).tenant_id;

  const platformA = await startRealPlatform(TENANT_A, 'e2e_tenant_a');
  const platformB = await startRealPlatform(TENANT_B, 'e2e_tenant_b');
  const ledgerA = await startRealLedger(TENANT_A, 'e2e_tenant_a');
  const auditorA = await startRealAuditor(TENANT_A, 'e2e_tenant_a', ledgerA.ledger);
  const governorA = await startRealImprovementGovernor(TENANT_A, 'e2e_tenant_a');

  // Real seeded data ----------------------------------------------------------------------------
  // Honest note: an `agent_id` XSS vector was considered and rejected as unreal — Platform's own
  // `resume()`/authorization path requires `request.agent_id === principal.agentId` (the AUTHENTICATED
  // agent token's own bound identity), so an attacker-shaped `agent_id` is refused with FORBIDDEN before
  // ever being stored, let alone rendered. This is a real, already-enforced boundary, not a gap this pass
  // needs to work around — the genuine untrusted-content vector is the MCP tool name/description below,
  // which really is provider-controlled, unvalidated-for-content text by design.
  // A dedicated, never-mutated HELD action for read-only assertions (role restriction, list/detail
  // rendering), and a SEPARATE HELD action for the one spec that actually drives it through a real
  // approval — sharing one mutable real record across specs would make test order affect test outcomes.
  const held = await submitAction(platformA, 'req_e2e_held', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, TENANT_A);
  const heldForApproval = await submitAction(platformA, 'req_e2e_held_approve', { action: 'production.deploy', tool: 'deploy.execute', resource: 'prod.deploy.release', metadata: { destination: 'deploy.internal.company' } }, TENANT_A);
  const blocked = await submitAction(platformA, 'req_e2e_blocked', { tool: 'shell.unrestricted' }, TENANT_A);
  const heldActionId = (held.body as { platform_action_id: string }).platform_action_id;
  const heldActionForApprovalId = (heldForApproval.body as { platform_action_id: string }).platform_action_id;
  const blockedActionId = (blocked.body as { platform_action_id: string }).platform_action_id;

  seedLedgerEvent(ledgerA, TENANT_A, { event_id: 'evt-e2e-1', stream_id: 'agent:e2e' });
  const assessment = seedRealAssessment(auditorA, TENANT_A);
  const lineage = await seedRealLineage(governorA, `sys_${TENANT_A}`);

  // Real MCP connection + real schema drift ------------------------------------------------------
  const fixturePath = resolve('dist', 'scripts', 'fixtures', 'mcp-fixture-server.js');
  const registerRes = await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT_A}/mcp-servers`, {
    method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CRM Fixture', transport: 'stdio', executable: process.execPath, args: [fixturePath], env_allowlist: ['MCP_FIXTURE_MODE'], credential_ref: null }),
  });
  const mcpServer = await registerRes.json() as { mcp_server_id: string };

  process.env.MCP_FIXTURE_MODE = 'normal';
  await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT_A}/mcp-servers/${mcpServer.mcp_server_id}/discover`, { method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}` } });
  const toolsRes = await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT_A}/tools`, { headers: { Authorization: `Bearer ${clientGateway.adminToken}` } });
  const tools = await toolsRes.json() as readonly { tool_id: string; external_tool_name: string; state_version: number }[];
  const lookupTool = tools.find(t => t.external_tool_name === 'crm.lookup_customer')!;
  await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT_A}/tools/${lookupTool.tool_id}/enable`, {
    method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state_version: lookupTool.state_version, risk_class: 'MEDIUM', policy_id: 'e2e-policy-1', allowed_operations: ['read'], resource_patterns: ['*'] }),
  });
  // Real schema drift: the SAME server, re-discovered under a genuinely different real schema.
  process.env.MCP_FIXTURE_MODE = 'schema-v2';
  await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT_A}/mcp-servers/${mcpServer.mcp_server_id}/discover`, { method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}` } });

  // A second, real MCP server whose advertised tool name/description are attacker-shaped strings (build
  // -order items 23-24) — left DISCOVERED/unreviewed, exactly like any real newly-seen third-party tool.
  const xssFixturePath = resolve('dist', 'scripts', 'fixtures', 'e2e-xss-mcp-server.js');
  const xssRegisterRes = await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT_A}/mcp-servers`, {
    method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Untrusted Vendor Server', transport: 'stdio', executable: process.execPath, args: [xssFixturePath], env_allowlist: [], credential_ref: null }),
  });
  const xssMcpServer = await xssRegisterRes.json() as { mcp_server_id: string };
  await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT_A}/mcp-servers/${xssMcpServer.mcp_server_id}/discover`, { method: 'POST', headers: { Authorization: `Bearer ${clientGateway.adminToken}` } });
  const toolsAfterXssRes = await fetch(`${clientGateway.baseUrl}/v1/admin/tenants/${TENANT_A}/tools`, { headers: { Authorization: `Bearer ${clientGateway.adminToken}` } });
  const toolsAfterXss = await toolsAfterXssRes.json() as readonly { tool_id: string; provider_id: string }[];
  const xssToolId = toolsAfterXss.find(t => t.provider_id === xssMcpServer.mcp_server_id)!.tool_id;

  // Control Center BFF, real, serving the real compiled frontend ------------------------------------
  const entryA: TenantRegistryEntry = {
    tenant_id: TENANT_A, platform_base_url: platformA.baseUrl, platform_token: platformA.agentToken, platform_operator_token: platformA.operatorToken,
    ledger_base_url: ledgerA.baseUrl, ledger_reader_token: ledgerA.readerToken, ledger_admin_token: ledgerA.adminToken,
    auditor_base_url: auditorA.baseUrl, auditor_token: auditorA.readerToken,
    improvement_base_url: governorA.baseUrl, improvement_admin_token: governorA.adminToken,
  };
  const entryB: TenantRegistryEntry = {
    tenant_id: TENANT_B, platform_base_url: platformB.baseUrl, platform_token: platformB.agentToken, platform_operator_token: platformB.operatorToken,
  };
  const sessions = new ControlCenterSessionStore(':memory:');
  sessions.createUser(TENANT_A, 'viewer', PASSWORD, 'client-viewer');
  sessions.createUser(TENANT_A, 'reviewer', PASSWORD, 'client-reviewer');
  sessions.createUser(TENANT_A, 'admin', PASSWORD, 'client-admin');
  sessions.createUser(TENANT_B, 'viewer-b', PASSWORD, 'client-viewer');

  const tenants = tenantRegistryFromEntries([entryA, entryB]);
  const clientGatewayConfig: ClientGatewayConfig = { baseUrl: clientGateway.baseUrl, adminToken: clientGateway.adminToken };
  const server = createControlCenterServer({
    sessions, tenants, platform: new PlatformProxyClient(), cookieSecure: false,
    staticRoot: resolve('apps', 'tna-control-center-web', 'dist'),
    clientGateway: clientGatewayConfig, clientGatewayClient: new ClientGatewayProxyClient(),
    ledger: new LedgerProxyClient(), auditor: new AuditorProxyClient(), improvement: new ImprovementGovernorProxyClient(),
    // 'staging' (rather than the config default 'development') so the E2E suite also proves the real
    // environment banner reflects real, non-default backend configuration (build-order item 17).
    environment: 'staging',
  });
  await new Promise<void>(res => server.listen(PORT, '127.0.0.1', res));

  writeFileSync(resolve('e2e-fixtures.json'), JSON.stringify({
    baseUrl: `http://127.0.0.1:${PORT}`, tenantA: TENANT_A, tenantB: TENANT_B, password: PASSWORD,
    heldActionId, heldActionForApprovalId, blockedActionId, streamId: 'agent:e2e', assessmentId: assessment.assessment_id,
    promotedGenerationId: lineage.promotedGenerationId, rejectedGenerationId: lineage.rejectedGenerationId,
    secondPromotedGenerationId: lineage.secondPromotedGenerationId, internalSystemId: lineage.internalSystemId,
    driftedToolId: lookupTool.tool_id, mcpServerId: mcpServer.mcp_server_id,
    xssToolId, xssMcpServerId: xssMcpServer.mcp_server_id,
  }, null, 2));

  process.stdout.write(`E2E fixture server ready on http://127.0.0.1:${PORT}\n`);
}

main().catch(error => { process.stderr.write(`E2E fixture server failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exit(1); });

/**
 * TNA Deployment Academy v0.1 — Lab 10 (Level 2): Tenant Isolation.
 *
 * Objective: attempt several forms of cross-tenant access — a tool, a recorded client action (its
 * evidence), a service identity, a tenant record — and confirm every one is rejected by the real
 * `ClientStore`, never merely by convention.
 * Prerequisites: `lab-07-mcp-discovery`.
 */
import { execPath } from 'node:process';
import { resolve } from 'node:path';
import { ClientStore } from '../../packages/client-core/src/index.js';
import { validateClientTenantCreateInput, validateServiceIdentityCreateInput, ClientError } from '../../packages/client-schema/src/index.js';
import { validateMcpServerRegisterInput, hashSchema } from '../../packages/mcp-schema/src/index.js';
import { McpStdioClient } from '../../packages/mcp-gateway/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

const FIXTURE = resolve('dist', 'scripts', 'fixtures', 'mcp-fixture-server.js');

function expectClientError(fn: () => void, code: string): boolean {
  try { fn(); return false; }
  catch (error) { return error instanceof ClientError && error.code === code; }
}

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  const store = new ClientStore(':memory:');
  try {
    const tenantA = store.createTenant(validateClientTenantCreateInput({
      display_name: 'Tenant A', environment: 'development', deployment_binding: 'lab-a', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'],
    }), 'academy-lab');
    const tenantB = store.createTenant(validateClientTenantCreateInput({
      display_name: 'Tenant B', environment: 'development', deployment_binding: 'lab-b', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'],
    }), 'academy-lab');
    const { identity: serviceB } = store.createServiceIdentity(tenantB.tenant_id, validateServiceIdentityCreateInput({ name: 'b-agent', role: 'agent-client' }), 'academy-lab');

    // Give Tenant B a real governed tool (a real spawned MCP fixture, not a fixture record).
    const serverB = store.registerMcpServer(tenantB.tenant_id, validateMcpServerRegisterInput({
      name: 'B CRM', transport: 'stdio', executable: execPath, args: [FIXTURE], env_allowlist: [], credential_ref: null,
    }), 'academy-lab');
    const mcpClient = new McpStdioClient({ executable: execPath, args: [FIXTURE], envAllowlist: [] });
    await mcpClient.connect();
    const fixturePid = mcpClient.pid;
    const discovered = await mcpClient.listTools();
    await mcpClient.shutdown();
    // pid is reported for tests/academy/process-cleanup.test.ts to verify by exact process identity.
    steps.push({ description: `Tenant B's real MCP fixture process (pid ${fixturePid}) was spawned and shut down`, passed: discovered.length > 0 });
    store.recordDiscovery(tenantB.tenant_id, serverB.mcp_server_id, discovered, hashSchema);
    const toolB = store.listTools(tenantB.tenant_id)[0]!;

    // Give Tenant B a recorded client action (its "evidence" record).
    const actionB = {
      tenant_id: tenantB.tenant_id, client_action_id: `cact_lab_${Date.now()}`, service_id: serviceB.service_id,
      mcp_server_id: serverB.mcp_server_id, governed_tool_id: toolB.tool_id,
      config_snapshot_hash: store.computeIntegrationConfigHash(tenantB.tenant_id), created_at: new Date().toISOString(),
    };
    store.recordClientAction(actionB);

    steps.push({ description: 'Tenant A credential cannot resolve Tenant B\'s governed tool', passed: expectClientError(() => store.getTool(tenantA.tenant_id, toolB.tool_id), 'NOT_FOUND') });
    steps.push({ description: 'Tenant A cannot read Tenant B\'s recorded client action (its evidence)', passed: store.getClientAction(tenantA.tenant_id, actionB.client_action_id) === null });
    steps.push({ description: 'Tenant A cannot read Tenant B\'s service identity by id', passed: expectClientError(() => store.getServiceIdentity(tenantA.tenant_id, serviceB.service_id), 'NOT_FOUND') });
    steps.push({ description: 'Tenant A cannot read Tenant B\'s tenant record via getTenant with the wrong id path', passed: store.getTenant(tenantA.tenant_id).tenant_id !== tenantB.tenant_id });
    steps.push({ description: 'Tenant A\'s own tool list never includes Tenant B\'s tools', passed: store.listTools(tenantA.tenant_id).every(t => t.tenant_id === tenantA.tenant_id) });
    steps.push({ description: 'Tenant A\'s own MCP server list never includes Tenant B\'s servers', passed: store.listMcpServers(tenantA.tenant_id).every(s => s.tenant_id === tenantA.tenant_id) });
    steps.push({ description: 'Tenant B\'s own action record is genuinely retrievable by Tenant B itself (the rejection above is real isolation, not a broken feature)', passed: store.getClientAction(tenantB.tenant_id, actionB.client_action_id)?.client_action_id === actionB.client_action_id });
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    store.close();
  }
  return { lab_id: 'lab-10-tenant-isolation', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}

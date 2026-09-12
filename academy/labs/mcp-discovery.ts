/**
 * TNA Deployment Academy v0.1 — Level 2 Lab: MCP Tool Discovery.
 *
 * Objective: register a real local MCP fixture server, discover its tools through the real MCP gateway,
 * and observe that discovery alone never grants execution authority (TNA-58: "Discovery Does Not Grant
 * Authority").
 * Prerequisites: Level 1 (Gate, authority), Level 2 MCP concepts.
 *
 * Runs against the REAL `packages/client-core` `ClientStore` and a REAL spawned MCP fixture process.
 */
import { execPath } from 'node:process';
import { resolve } from 'node:path';
import { ClientStore } from '../../packages/client-core/src/index.js';
import { validateClientTenantCreateInput, validateServiceIdentityCreateInput } from '../../packages/client-schema/src/index.js';
import { validateMcpServerRegisterInput, hashSchema } from '../../packages/mcp-schema/src/index.js';
import { McpStdioClient } from '../../packages/mcp-gateway/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

const FIXTURE = resolve('dist', 'scripts', 'fixtures', 'mcp-fixture-server.js');

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  const store = new ClientStore(':memory:');
  try {
    const tenant = store.createTenant(validateClientTenantCreateInput({
      display_name: 'Academy Lab Co', environment: 'development', deployment_binding: 'academy-lab',
      policy_profile: 'default', allowed_connector_types: ['mcp-stdio'],
    }), 'academy-lab');
    store.createServiceIdentity(tenant.tenant_id, validateServiceIdentityCreateInput({ name: 'lab-agent', role: 'agent-client' }), 'academy-lab');
    const server = store.registerMcpServer(tenant.tenant_id, validateMcpServerRegisterInput({
      name: 'Academy Lab CRM', transport: 'stdio', executable: execPath, args: [FIXTURE], env_allowlist: [], credential_ref: null,
    }), 'academy-lab');

    const client = new McpStdioClient({ executable: execPath, args: [FIXTURE], envAllowlist: [] });
    await client.connect();
    const fixturePid = client.pid;
    const discovered = await client.listTools();
    await client.shutdown();
    // pid is reported for tests/academy/process-cleanup.test.ts to verify by exact process identity —
    // never by a system-wide command-line search, which would be racy against concurrently running tests.
    steps.push({ description: `A real MCP process (pid ${fixturePid}) was spawned and advertised its tools`, passed: discovered.length === 2 });

    const result = store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, discovered, hashSchema);
    steps.push({ description: 'Discovery recorded new governed tools', passed: result.created.length === 2 });

    const tools = store.listTools(tenant.tenant_id);
    steps.push({ description: 'TNA-58: every newly discovered tool is enabled:false — discovery never grants authority', passed: tools.every(t => t.enabled === false) });
    steps.push({ description: 'TNA-58: every newly discovered tool has review_status DISCOVERED, not ENABLED', passed: tools.every(t => t.review_status === 'DISCOVERED') });
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    store.close();
  }
  return { lab_id: 'lab-07-mcp-discovery', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}

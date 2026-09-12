/**
 * TNA Deployment Academy v0.1 — Level 2 Lab: Schema Drift.
 *
 * Objective: enable a governed tool, then observe a real schema change on rediscovery disable it
 * automatically (TNA-60: "Schema Drift Is Authority Drift").
 * Prerequisites: `mcp-discovery` lab.
 */
import { execPath } from 'node:process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ClientStore } from '../../packages/client-core/src/index.js';
import { validateClientTenantCreateInput, validateServiceIdentityCreateInput } from '../../packages/client-schema/src/index.js';
import { validateMcpServerRegisterInput, hashSchema } from '../../packages/mcp-schema/src/index.js';
import { McpStdioClient } from '../../packages/mcp-gateway/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

const FIXTURE = resolve('dist', 'scripts', 'fixtures', 'mcp-fixture-server.js').replace(/\\/g, '/');

function writeModeWrapper(dir: string, mode: string): string {
  const wrapperPath = resolve(dir, `wrapper-${randomUUID().slice(0, 8)}.mjs`);
  writeFileSync(wrapperPath, `process.env.MCP_FIXTURE_MODE = ${JSON.stringify(mode)};\nawait import(${JSON.stringify(`file://${FIXTURE}`)});\n`);
  return wrapperPath;
}

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab-drift-'));
  const store = new ClientStore(':memory:');
  try {
    const tenant = store.createTenant(validateClientTenantCreateInput({
      display_name: 'Drift Lab Co', environment: 'development', deployment_binding: 'drift-lab',
      policy_profile: 'default', allowed_connector_types: ['mcp-stdio'],
    }), 'academy-lab');
    store.createServiceIdentity(tenant.tenant_id, validateServiceIdentityCreateInput({ name: 'lab-agent', role: 'agent-client' }), 'academy-lab');
    const normalWrapper = writeModeWrapper(dir, 'normal');
    const server = store.registerMcpServer(tenant.tenant_id, validateMcpServerRegisterInput({
      name: 'Drift Lab CRM', transport: 'stdio', executable: execPath, args: [normalWrapper], env_allowlist: [], credential_ref: null,
    }), 'academy-lab');

    const initialClient = new McpStdioClient({ executable: execPath, args: [normalWrapper], envAllowlist: [] });
    await initialClient.connect();
    const initialPid = initialClient.pid;
    const initial = await initialClient.listTools();
    await initialClient.shutdown();
    // pids are reported for tests/academy/process-cleanup.test.ts to verify by exact process identity.
    steps.push({ description: `Initial discovery MCP process (pid ${initialPid}) was spawned and shut down`, passed: initial.length > 0 });
    store.recordDiscovery(tenant.tenant_id, server.mcp_server_id, initial, hashSchema);
    const lookupTool = store.listTools(tenant.tenant_id).find(t => t.external_tool_name === 'crm.lookup_customer')!;
    const { tool: enabled } = store.enableTool(tenant.tenant_id, lookupTool.tool_id, lookupTool.state_version, {
      risk_class: 'LOW', allowed_operations: ['read'], resource_patterns: ['/workspace/**'],
      requires_human_approval: false, requires_vad: false, policy_id: 'lab-policy', runtime_limits: {}, cost_limits: {}, bound_by: 'academy-lab',
    });
    steps.push({ description: 'Tool was reviewed and enabled at schema H1', passed: enabled.enabled === true });
    const hashBefore = enabled.schema_hash;

    // Reconfigure the SAME server to point at a schema-v2 wrapper, then rediscover — genuine drift.
    // The first discovery already bumped the server's own state_version (marking it REACHABLE), so its
    // current version must be re-read rather than reusing the stale value from registration.
    const currentServer = store.getMcpServer(tenant.tenant_id, server.mcp_server_id);
    const driftWrapper = writeModeWrapper(dir, 'schema-v2');
    const reconfigured = store.reconfigureMcpServer(tenant.tenant_id, currentServer.mcp_server_id, currentServer.state_version, validateMcpServerRegisterInput({
      name: 'Drift Lab CRM', transport: 'stdio', executable: execPath, args: [driftWrapper], env_allowlist: [], credential_ref: null,
    }));
    const driftClient = new McpStdioClient({ executable: execPath, args: [driftWrapper], envAllowlist: [] });
    await driftClient.connect();
    const driftPid = driftClient.pid;
    const drifted = await driftClient.listTools();
    await driftClient.shutdown();
    steps.push({ description: `Drift rediscovery MCP process (pid ${driftPid}) was spawned and shut down`, passed: drifted.length > 0 });
    const driftResult = store.recordDiscovery(tenant.tenant_id, reconfigured.mcp_server_id, drifted, hashSchema);
    steps.push({ description: 'Real rediscovery detected the schema change on the same tool_id', passed: driftResult.driftDetected.includes(lookupTool.tool_id) });

    const after = store.getTool(tenant.tenant_id, lookupTool.tool_id);
    steps.push({ description: 'TNA-60: the schema hash genuinely changed', passed: after.schema_hash !== hashBefore });
    steps.push({ description: 'TNA-60: the tool was automatically disabled — no execution under the stale approval', passed: after.enabled === false });
    steps.push({ description: 'TNA-60: the tool is marked POLICY_REVIEW_REQUIRED, not silently re-approved', passed: after.review_status === 'POLICY_REVIEW_REQUIRED' });
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { lab_id: 'lab-08-schema-drift', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}

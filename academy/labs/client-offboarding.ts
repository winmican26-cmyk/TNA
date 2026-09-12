/**
 * TNA Deployment Academy v0.1 — Lab 14 (Level 2): Client Offboarding.
 *
 * Objective: take a real client tenant from ACTIVE through OFFBOARDING to OFFBOARDED and confirm the
 * cascade is real: new authority revoked, credentials unusable, tools disabled — while historical
 * evidence (a previously recorded client action) remains intact and readable.
 * Prerequisites: `lab-10-tenant-isolation`.
 */
import { ClientStore } from '../../packages/client-core/src/index.js';
import { validateClientTenantCreateInput, validateServiceIdentityCreateInput } from '../../packages/client-schema/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  const store = new ClientStore(':memory:');
  try {
    const tenant = store.createTenant(validateClientTenantCreateInput({
      display_name: 'Lab 14 Co', environment: 'development', deployment_binding: 'lab-14', policy_profile: 'default', allowed_connector_types: ['mcp-stdio'],
    }), 'academy-lab');
    const { identity: service, credential } = store.createServiceIdentity(tenant.tenant_id, validateServiceIdentityCreateInput({ name: 'lab14-agent', role: 'agent-client' }), 'academy-lab');
    const active = store.activateTenant(tenant.tenant_id, tenant.state_version);
    steps.push({ description: 'Tenant is ACTIVE before offboarding begins', passed: active.status === 'ACTIVE' });

    const preOffboardHistory = {
      tenant_id: active.tenant_id, client_action_id: 'cact_lab14_history', service_id: service.service_id,
      mcp_server_id: null, governed_tool_id: null, config_snapshot_hash: store.computeIntegrationConfigHash(active.tenant_id),
      created_at: new Date().toISOString(),
    };
    store.recordClientAction(preOffboardHistory);
    steps.push({ description: 'A real historical client action was recorded while ACTIVE', passed: store.getClientAction(active.tenant_id, 'cact_lab14_history') !== null });

    const authenticatedBeforeOffboard = store.authenticateService(credential.token);
    steps.push({ description: 'The real credential authenticates successfully before offboarding', passed: authenticatedBeforeOffboard?.service_id === service.service_id });

    const offboarding = store.beginOffboarding(active.tenant_id, active.state_version, 'lab 14: client relationship ended', 'academy-lab');
    steps.push({ description: 'Tenant transitioned ACTIVE -> OFFBOARDING', passed: offboarding.status === 'OFFBOARDING' });

    const serviceAfter = store.getServiceIdentity(active.tenant_id, service.service_id);
    steps.push({ description: 'Service identity was revoked by the cascade', passed: serviceAfter.status === 'REVOKED' });

    const authenticatedAfterOffboard = store.authenticateService(credential.token);
    steps.push({ description: 'The credential is now genuinely unusable — authentication fails after revocation', passed: authenticatedAfterOffboard === null });

    let newActionRejected = false;
    try { store.assertActionEligible(active.tenant_id); }
    catch { newActionRejected = true; }
    steps.push({ description: 'New authority is revoked: a new consequential action is refused while OFFBOARDING', passed: newActionRejected });

    const completed = store.completeOffboarding(active.tenant_id, offboarding.state_version);
    steps.push({ description: 'Tenant transitioned OFFBOARDING -> OFFBOARDED', passed: completed.status === 'OFFBOARDED' });

    const historyAfter = store.getClientAction(active.tenant_id, 'cact_lab14_history');
    steps.push({ description: 'Historical evidence recorded before offboarding remains intact and readable after OFFBOARDED', passed: historyAfter?.client_action_id === 'cact_lab14_history' });
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    store.close();
  }
  return { lab_id: 'lab-14-client-offboarding', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}

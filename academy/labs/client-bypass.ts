/**
 * TNA Deployment Academy v0.1 — Lab 09 (Level 2): Client Bypass.
 *
 * Objective: model a client whose agent retains a direct external credential to the governed system,
 * confirm the real bypass-assessment function reports `KNOWN_BYPASS`, and confirm the real go-live
 * assessment can never surface a clean high-assurance result while that is true.
 * Prerequisites: `lab-07-mcp-discovery`.
 */
import { computeBypassAssessment } from '../../packages/client-schema/src/index.js';
import { assessGoLive } from '../../apps/tna-operator/src/go-live.js';
import type { LabResult, LabStep } from './blocked-action.js';

function baseGoLiveInput() {
  return {
    tenant_id: 'ten_academy_lab9', deployment_ready: true, gate_available: true, sentinel_available: true, ledger_available: true,
    tenant_active: true, active_services: 1, reachable_mcp_servers: 1, enabled_tools: 1, tools_requiring_review: 0,
    bypass_attestation: null as { tnaCredentialChain: boolean; externalDirectCredential: boolean } | null,
    test_action_completed: true, backup_age_seconds: null, max_backup_age_seconds: 86_400,
    allow_known_bypass_with_limitations: false,
  };
}

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  try {
    const clean = computeBypassAssessment({ tnaCredentialChain: true, externalDirectCredential: false });
    steps.push({ description: 'A tenant whose agents only ever use the TNA-issued credential chain assesses as NO_KNOWN_BYPASS', passed: clean === 'NO_KNOWN_BYPASS' });

    // The learner's scenario: the client's agent ALSO retained a direct, external credential to the
    // same governed system, outside TNA's own credential chain entirely.
    const modeled = computeBypassAssessment({ tnaCredentialChain: true, externalDirectCredential: true });
    steps.push({ description: 'CAN_CLIENT_BYPASS_TNA = KNOWN_BYPASS once a direct external credential exists, even though the TNA chain itself still works', passed: modeled === 'KNOWN_BYPASS' });

    const goLiveClean = assessGoLive({ ...baseGoLiveInput(), bypass_attestation: { tnaCredentialChain: true, externalDirectCredential: false } });
    steps.push({ description: 'With no known bypass and every other check healthy, go-live assessment can reach a clean GO', passed: goLiveClean.status === 'GO' });

    const goLiveBypassed = assessGoLive({ ...baseGoLiveInput(), bypass_attestation: { tnaCredentialChain: true, externalDirectCredential: true } });
    steps.push({ description: 'With KNOWN_BYPASS, go-live assessment is NO_GO by default — never a clean high-assurance result', passed: goLiveBypassed.status === 'NO_GO' });
    steps.push({ description: 'Even with every operational check otherwise passing, KNOWN_BYPASS alone is enough to prevent a clean GO', passed: goLiveBypassed.status !== 'GO' });

    const goLiveBypassedWithLimitations = assessGoLive({ ...baseGoLiveInput(), bypass_attestation: { tnaCredentialChain: true, externalDirectCredential: true }, allow_known_bypass_with_limitations: true });
    steps.push({ description: 'Even when an operator explicitly accepts the known bypass, the best possible result is GO_WITH_LIMITATIONS — never a clean GO', passed: goLiveBypassedWithLimitations.status === 'GO_WITH_LIMITATIONS' });
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  }
  return { lab_id: 'lab-09-client-bypass', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}

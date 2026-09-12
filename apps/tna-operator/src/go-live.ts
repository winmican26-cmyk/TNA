/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Section 110-116: `ClientGoLiveAssessment
 * v1` — a deterministic, evidence-bound readiness decision. Section 126 (required statement, verbatim):
 * "TNA Client Go-Live Assessment evaluates configured operational readiness against available system
 * evidence. It does not certify security, regulatory compliance, contractual compliance, or absence of
 * risk." Section 112: a KNOWN_BYPASS can never surface as a clean GO. Section 127: an operator's own
 * acceptance of a limitation must never rewrite what the evidence actually says.
 */
import { createHash } from 'node:crypto';
import { computeBypassAssessment, type BypassAssessment } from '../../../packages/client-schema/src/index.js';

export const GO_LIVE_STATEMENT =
  'TNA Client Go-Live Assessment evaluates configured operational readiness against available system ' +
  'evidence. It does not certify security, regulatory compliance, contractual compliance, or absence of risk.';

export type GoLiveStatus = 'GO' | 'GO_WITH_LIMITATIONS' | 'NO_GO' | 'INSUFFICIENT_EVIDENCE';

export interface GoLiveCheck { readonly check: string; readonly passed: boolean; readonly blocking: boolean; readonly detail: string }

export interface GoLiveInput {
  readonly tenant_id: string;
  readonly deployment_ready: boolean;
  readonly gate_available: boolean;
  readonly sentinel_available: boolean;
  readonly ledger_available: boolean;
  readonly tenant_active: boolean;
  readonly active_services: number;
  readonly reachable_mcp_servers: number;
  readonly enabled_tools: number;
  readonly tools_requiring_review: number;
  readonly bypass_attestation: { readonly tnaCredentialChain: boolean; readonly externalDirectCredential: boolean } | null;
  readonly test_action_completed: boolean | null;
  readonly backup_age_seconds: number | null;
  readonly max_backup_age_seconds: number;
  /** Section 112: an operator profile may explicitly permit shipping with a known, documented bypass
   * (e.g. a migration in progress) — absent that explicit permission, KNOWN_BYPASS forces NO_GO, never a
   * silent GO_WITH_LIMITATIONS the operator didn't actually ask for. */
  readonly allow_known_bypass_with_limitations: boolean;
}

export interface GoLiveAssessment {
  readonly version: '1.0';
  readonly tenant_id: string;
  readonly assessed_at: string;
  readonly status: GoLiveStatus;
  readonly bypass_assessment: BypassAssessment | 'UNKNOWN';
  readonly checks: readonly GoLiveCheck[];
  readonly statement: string;
  readonly snapshot_hash: string;
}

export function assessGoLive(input: GoLiveInput): GoLiveAssessment {
  const checks: GoLiveCheck[] = [];
  checks.push({ check: 'deployment_ready', passed: input.deployment_ready, blocking: true, detail: input.deployment_ready ? 'Platform deployment reports ready' : 'Platform deployment is not ready' });
  checks.push({ check: 'gate_available', passed: input.gate_available, blocking: true, detail: input.gate_available ? 'Gate is available' : 'Gate is unavailable — no action can be authorized' });
  checks.push({ check: 'ledger_available', passed: input.ledger_available, blocking: true, detail: input.ledger_available ? 'Ledger is available' : 'Ledger integrity/availability check failed' });
  checks.push({ check: 'sentinel_available', passed: input.sentinel_available, blocking: true, detail: input.sentinel_available ? 'Sentinel is available' : 'Sentinel is unavailable — high-risk governed execution cannot be safely monitored' });
  checks.push({ check: 'tenant_active', passed: input.tenant_active, blocking: true, detail: input.tenant_active ? 'Tenant is ACTIVE' : 'Tenant is not ACTIVE' });
  checks.push({ check: 'service_identity_exists', passed: input.active_services > 0, blocking: true, detail: `${input.active_services} active service identit${input.active_services === 1 ? 'y' : 'ies'}` });
  checks.push({ check: 'mcp_reachable', passed: input.reachable_mcp_servers > 0, blocking: false, detail: `${input.reachable_mcp_servers} reachable MCP server(s)` });
  checks.push({ check: 'policy_bound', passed: input.enabled_tools > 0, blocking: false, detail: `${input.enabled_tools} enabled tool(s)` });
  checks.push({ check: 'no_schema_drift_pending', passed: input.tools_requiring_review === 0, blocking: true, detail: input.tools_requiring_review === 0 ? 'No tools pending policy review' : `${input.tools_requiring_review} tool(s) require policy review (schema drift or unreviewed discovery)` });
  if (input.test_action_completed !== null) {
    checks.push({ check: 'test_action_completed', passed: input.test_action_completed, blocking: false, detail: input.test_action_completed ? 'A real governed test action completed successfully' : 'The referenced test action did not complete successfully' });
  }
  if (input.backup_age_seconds !== null) {
    checks.push({ check: 'backup_recent', passed: input.backup_age_seconds <= input.max_backup_age_seconds, blocking: false, detail: `Last backup ${input.backup_age_seconds}s ago (policy max ${input.max_backup_age_seconds}s)` });
  }

  const bypass: BypassAssessment | 'UNKNOWN' = input.bypass_attestation ? computeBypassAssessment(input.bypass_attestation) : 'UNKNOWN';
  const blockingFailed = checks.some(c => c.blocking && !c.passed);
  const nonBlockingFailed = checks.some(c => !c.blocking && !c.passed);

  let status: GoLiveStatus;
  if (blockingFailed) {
    status = 'NO_GO';
  } else if (bypass === 'KNOWN_BYPASS') {
    // Section 112: never a clean GO with a known bypass — NO_GO unless the profile explicitly permits
    // shipping with this documented limitation, in which case GO_WITH_LIMITATIONS (still never GO).
    status = input.allow_known_bypass_with_limitations ? 'GO_WITH_LIMITATIONS' : 'NO_GO';
  } else if (bypass === 'UNKNOWN') {
    status = 'INSUFFICIENT_EVIDENCE';
  } else if (nonBlockingFailed) {
    status = 'GO_WITH_LIMITATIONS';
  } else {
    status = 'GO';
  }

  const assessedAt = new Date().toISOString();
  const snapshotHash = createHash('sha256').update(JSON.stringify({ tenant_id: input.tenant_id, assessed_at: assessedAt, checks, bypass, status })).digest('hex');
  return { version: '1.0', tenant_id: input.tenant_id, assessed_at: assessedAt, status, bypass_assessment: bypass, checks, statement: GO_LIVE_STATEMENT, snapshot_hash: snapshotHash };
}

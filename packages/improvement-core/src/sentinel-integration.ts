import { randomUUID, createHash } from 'node:crypto';
import { SentinelRuntime, adminPrincipal, controllerPrincipal, observerPrincipal } from '../../../packages/sentinel-runtime/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section D-E: real Sentinel integration for
 * candidate/canary execution monitoring. Deliberately thin — every observation this module builds uses
 * only the real, closed `OBSERVATION_TYPES`/`OBSERVATION_SOURCES` vocabulary already accepted in
 * `packages/sentinel-schema`; nothing here invents a new source or observation type. Mirrors the exact
 * real pattern already proven in `academy/labs/sentinel-termination.ts` (Volume 11).
 */

const IMPROVEMENT_CONTROLLER_ID = 'improvement-governor-controller';
const IMPROVEMENT_OBSERVER_ID = 'improvement-governor-observer';
const IMPROVEMENT_ADMIN_ID = 'improvement-governor-admin';

export function installImprovementSentinelPolicy(sentinel: SentinelRuntime, tenantId: string): void {
  sentinel.installDefaultPolicy(adminPrincipal(IMPROVEMENT_ADMIN_ID, tenantId));
}

export interface CandidateSessionInput {
  readonly tenantId: string;
  readonly generationId: string;
  readonly expectedAction: string;
  readonly expectedTool: string;
  readonly expectedResource: string;
  readonly allowedDestinations: readonly string[];
  readonly allowedOperations: readonly ('read' | 'write' | 'create' | 'delete')[];
  readonly maxRuntimeSeconds: number;
  readonly maxCostUsd: number;
  readonly authorityExpiryMs?: number;
  /** Both optional in the underlying schema — MISSING_HEARTBEAT never fires unless both are set
   * explicitly (`packages/sentinel-schema`'s `RuntimeLimits`). */
  readonly heartbeatIntervalSeconds?: number;
  readonly heartbeatGraceSeconds?: number;
}

/** Creates a real Sentinel session bound to one candidate generation's execution (or canary run). The
 * session's `authority_snapshot_hash`/`policy_snapshot_hash` are deterministically derived from the
 * generation id so a later `AUTHORITY_RECHECK` observation can report a genuinely different hash to
 * demonstrate real drift detection (section D). */
export function createCandidateSession(sentinel: SentinelRuntime, input: CandidateSessionInput) {
  const policyHash = createHash('sha256').update(`improvement-generation:${input.generationId}`).digest('hex');
  return sentinel.createSession(controllerPrincipal(IMPROVEMENT_CONTROLLER_ID, input.tenantId), {
    version: '1.0', tenant_id: input.tenantId, agent_id: `candidate:${input.generationId}`,
    execution_id: `exec_${randomUUID()}`, correlation_id: `corr_${input.generationId}`,
    authority_snapshot_hash: policyHash, policy_snapshot_hash: policyHash,
    expected_action: input.expectedAction, expected_tool: input.expectedTool, expected_resource: input.expectedResource,
    allowed_destinations: [...input.allowedDestinations], allowed_operations: [...input.allowedOperations],
    authority_expiry: new Date(Date.now() + (input.authorityExpiryMs ?? 3_600_000)).toISOString(),
    runtime_limits: {
      max_runtime_seconds: input.maxRuntimeSeconds,
      ...(input.heartbeatIntervalSeconds !== undefined ? { heartbeat_interval_seconds: input.heartbeatIntervalSeconds } : {}),
      ...(input.heartbeatGraceSeconds !== undefined ? { heartbeat_grace_seconds: input.heartbeatGraceSeconds } : {}),
    },
    cost_limits: { max_cost_usd: input.maxCostUsd },
  });
}

function observationEnvelope(tenantId: string, sessionId: string) {
  return { version: '1.0' as const, observation_id: `obs_${randomUUID()}`, tenant_id: tenantId, sentinel_session_id: sessionId, timestamp: new Date().toISOString() };
}

/** A candidate/canary tool-call request — real `EXECUTION_BROKER`-sourced observation. Sentinel's own
 * `TOOL_NOT_ALLOWED` rule fires when `tool` diverges from the session's `expected_tool`. */
export async function submitCandidateToolCall(sentinel: SentinelRuntime, tenantId: string, sessionId: string, tool: string, resource: string) {
  return sentinel.submitObservation(observerPrincipal(IMPROVEMENT_OBSERVER_ID, tenantId, ['EXECUTION_BROKER']), sessionId, {
    ...observationEnvelope(tenantId, sessionId), source: 'EXECUTION_BROKER', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool, resource },
  });
}

/** A real `EGRESS_GUARD`-sourced network-request observation. `DESTINATION_NOT_ALLOWED` fires when
 * `destination` is not in the session's `allowed_destinations`. */
export async function submitCandidateNetworkRequest(sentinel: SentinelRuntime, tenantId: string, sessionId: string, destination: string) {
  return sentinel.submitObservation(observerPrincipal(IMPROVEMENT_OBSERVER_ID, tenantId, ['EGRESS_GUARD']), sessionId, {
    ...observationEnvelope(tenantId, sessionId), source: 'EGRESS_GUARD', observation_type: 'NETWORK_REQUEST', payload: { destination },
  });
}

/** A real `EXECUTION_BROKER`-sourced heartbeat. Also the observation used to let Sentinel's own
 * time-based rules (`RUNTIME_EXCEEDED`, `MISSING_HEARTBEAT`) evaluate against injected/advanced clock
 * time — Sentinel evaluates these deterministically from its own clock, never from a caller-asserted
 * elapsed-time claim. */
export async function submitCandidateHeartbeat(sentinel: SentinelRuntime, tenantId: string, sessionId: string) {
  return sentinel.submitObservation(observerPrincipal(IMPROVEMENT_OBSERVER_ID, tenantId, ['EXECUTION_BROKER']), sessionId, {
    ...observationEnvelope(tenantId, sessionId), source: 'EXECUTION_BROKER', observation_type: 'EXECUTION_HEARTBEAT', payload: {},
  });
}

/** A real `TNA_GATE`-sourced authority-recheck observation. The trusted source asserts `result` directly
 * (Sentinel derives its `AuthorityStatus` straight from this field — `packages/sentinel-runtime`'s
 * `authorityStatusFromObservation` — it does not independently diff hashes itself); `current_policy_hash`
 * rides along as accompanying evidence. This module never computes the authority decision itself, it only
 * submits the real observation Sentinel's own accepted rule engine evaluates. */
export async function submitAuthorityRecheck(sentinel: SentinelRuntime, tenantId: string, sessionId: string, result: 'VALID' | 'EXPIRED' | 'REVOKED' | 'POLICY_CHANGED' | 'UNKNOWN', options: { readonly currentPolicyHash?: string; readonly scope?: 'agent' | 'approval' } = {}) {
  return sentinel.submitObservation(observerPrincipal(IMPROVEMENT_OBSERVER_ID, tenantId, ['TNA_GATE']), sessionId, {
    ...observationEnvelope(tenantId, sessionId), source: 'TNA_GATE', observation_type: 'AUTHORITY_RECHECK',
    payload: { result, ...(options.currentPolicyHash ? { current_policy_hash: options.currentPolicyHash } : {}), ...(options.scope ? { scope: options.scope } : {}) },
  });
}

export { adminPrincipal as sentinelAdminPrincipal, controllerPrincipal as sentinelControllerPrincipal };

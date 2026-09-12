/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), sections 51-54/87. The only place in this
 * frontend that talks to the network. Every call sends `credentials: 'include'` (the session cookie is
 * HttpOnly and managed entirely by the browser — this file never reads or writes it) and echoes the
 * readable CSRF cookie back as a header on every mutating request. No token of any kind is ever read from
 * or written to `localStorage`/`sessionStorage` — session identity lives ONLY in the HttpOnly cookie the
 * server set, which this code cannot see and does not need to.
 */

export class ApiError extends Error {
  public constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find(row => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
const CSRF_COOKIE = 'tna_cc_csrf';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const mutating = method !== 'GET';
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (mutating) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(path, { method, headers, credentials: 'include', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  const parsed = text.length > 0 ? JSON.parse(text) as unknown : undefined;
  if (!res.ok) {
    const errObj = parsed as { error?: string; code?: string } | undefined;
    throw new ApiError(res.status, errObj?.error ?? `Request failed (${res.status})`, errObj?.code);
  }
  return parsed as T;
}

export interface SessionUser { readonly username: string; readonly tenant_id: string; readonly role: string; readonly permissions?: readonly string[]; readonly environment?: 'development' | 'staging' | 'production' | string }
export interface ComponentHealth { readonly component: string; readonly status: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | string; readonly mandatory?: boolean; readonly latency_ms?: number; readonly message?: string }
export interface Assurance { readonly status: string; readonly ready?: boolean; readonly components: readonly ComponentHealth[] }
export interface DashboardSummary {
  readonly assurance: Assurance;
  readonly actions_last_24h: number;
  readonly blocked: number;
  readonly held: number;
  readonly terminated: number;
  readonly indeterminate: number;
  readonly total_known_actions: number;
}
export interface PlatformActionSummary { readonly platform_action_id: string; readonly state: string; readonly tool?: string; readonly agent_id?: string; readonly created_at?: string; [key: string]: unknown }
export interface ActionsPage { readonly items: readonly PlatformActionSummary[]; readonly next_cursor?: string | null }

// ---------------------------------------------------------------------------------------------
// Connections / MCP (real `apps/tna-client-gateway` admin API, section on Volume 10 governed tools).
// ---------------------------------------------------------------------------------------------
export interface McpServerRegistration {
  readonly mcp_server_id: string; readonly name: string; readonly transport: string; readonly executable: string;
  readonly status: 'REGISTERED' | 'REACHABLE' | 'UNREACHABLE' | 'DISABLED' | string;
  readonly credential_ref: string | null; readonly created_at: string; readonly config_hash: string; readonly state_version: number;
}

// ---------------------------------------------------------------------------------------------
// Governed tools + schema drift (real Volume 10 `governed_tools`).
// ---------------------------------------------------------------------------------------------
export interface GovernedTool {
  readonly tool_id: string; readonly provider_id: string; readonly external_tool_name: string; readonly description: string;
  readonly schema_hash: string; readonly risk_class: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  readonly allowed_operations: readonly string[]; readonly resource_patterns: readonly string[];
  readonly enabled: boolean; readonly requires_human_approval: boolean; readonly requires_vad: boolean;
  readonly review_status: 'DISCOVERED' | 'ENABLED' | 'DISABLED' | 'POLICY_REVIEW_REQUIRED' | 'REMOVED' | string;
  readonly created_at: string; readonly updated_at: string; readonly state_version: number;
}

// ---------------------------------------------------------------------------------------------
// Evidence Explorer (real `apps/tna-ledger`).
// ---------------------------------------------------------------------------------------------
export interface LedgerEvent {
  readonly event_id: string; readonly event_type: string; readonly stream_id: string; readonly sequence: number;
  readonly correlation_id: string; readonly causation_id?: string | null; readonly parent_event_id?: string | null;
  readonly source_component: string; readonly occurred_at?: string; readonly received_at: string; readonly persisted_at: string;
  readonly actor: { readonly type: string; readonly id: string }; readonly payload_hash: string;
  readonly previous_event_hash: string; readonly event_hash: string; readonly payload?: Record<string, unknown>;
}
export interface LedgerPage { readonly items: readonly LedgerEvent[]; readonly nextCursor: string | null }
export interface StreamVerificationResult {
  readonly valid: boolean; readonly tenantId: string; readonly streamId: string; readonly eventsChecked: number;
  readonly firstInvalidSequence: number | null; readonly reason: string | null;
}
/** The real `Ledger.verifyAll()` shape (`validStreams`/`invalidStreams` counts) plus a `valid` field the
 * BFF derives (`invalidStreams === 0`) — a direct, non-fabricated projection of those real counts, never
 * an independently invented status. See `apps/tna-control-center/src/server.ts`'s `/api/evidence/verify`. */
export interface FullVerificationResult {
  readonly valid: boolean; readonly streamsChecked: number; readonly eventsChecked: number;
  readonly validStreams: number; readonly invalidStreams: number; readonly durationMs: number;
  readonly firstFailure: StreamVerificationResult | null;
}

// ---------------------------------------------------------------------------------------------
// Audit / Assurance (real `apps/tna-auditor`).
// ---------------------------------------------------------------------------------------------
export interface AssessmentRecord {
  readonly assessment_id: string; readonly name: string; readonly control_profile_id: string;
  readonly status: 'CREATED' | 'COLLECTING_EVIDENCE' | 'EVALUATING' | 'COMPLETED' | 'FAILED' | 'INDETERMINATE' | string;
  readonly outcome: 'PASS' | 'PASS_WITH_FINDINGS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE' | 'ERROR' | null;
  readonly created_at: string; readonly updated_at: string; readonly evidence_cutoff_at: string; readonly latest_run_number: number;
}
export interface ControlResult {
  readonly control_id: string; readonly status: 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_APPLICABLE' | 'INSUFFICIENT_EVIDENCE' | 'ERROR' | string;
  readonly evaluated_at: string; readonly reason_codes: readonly string[]; readonly observations: readonly string[]; readonly limitations: readonly string[];
}
export interface AuditFinding {
  readonly finding_id: string; readonly control_id: string; readonly severity: string; readonly status: string;
  readonly title: string; readonly description: string; readonly reason_codes: readonly string[]; readonly created_at: string;
}
export interface AuditPage<T> { readonly items: readonly T[]; readonly nextCursor: string | null }

// ---------------------------------------------------------------------------------------------
// Identities (real Volume 10 `ClientServiceIdentity`).
// ---------------------------------------------------------------------------------------------
export interface ServiceIdentity {
  readonly service_id: string; readonly name: string; readonly role: string; readonly status: 'ACTIVE' | 'REVOKED' | string;
  readonly credential_ref: string; readonly created_at: string; readonly last_rotated_at: string; readonly state_version: number;
}

// ---------------------------------------------------------------------------------------------
// Recursive Improvement (real `apps/tna-improvement-governor`, Volume 12).
// ---------------------------------------------------------------------------------------------
export interface ImprovementGeneration {
  readonly generation_id: string; readonly system_id: string; readonly parent_generation_id: string | null;
  readonly candidate_version: string; readonly improvement_class: string;
  readonly status: string; readonly spec_hash: string; readonly source_hash_before: string; readonly source_hash_after?: string | null;
  readonly authority_profile_before: unknown; readonly created_by: string; readonly created_at: string; readonly state_version: number;
}
export interface ImprovementGenerationsPage { readonly items: readonly ImprovementGeneration[]; readonly nextCursor?: string }
export interface ImprovementLineageNode { readonly generationId: string; readonly parentGenerationId: string | null; readonly finalState: string }
export interface LineageResult { readonly nodes: readonly ImprovementLineageNode[]; readonly roots: readonly string[] }
export interface ImprovementReconstruction {
  readonly generationId: string; readonly parentGenerationId: string | null; readonly proposed: boolean; readonly authorized: boolean; readonly built: boolean;
  readonly evaluated: { readonly decision?: string; readonly vad_final_state?: string; readonly reason?: string; readonly control_plane_changed?: boolean; readonly evaluator_changed?: boolean; readonly test_tampered?: boolean; readonly authority_within_ceiling?: boolean } | null;
  readonly capabilityDeltaDetected: boolean; readonly capabilityDelta: { readonly has_unexpected_gain?: boolean } | null;
  readonly authorityExpansion: { readonly status: string } | null; readonly finalState: string;
  readonly evidence: readonly { readonly eventType: string; readonly [key: string]: unknown }[];
}
export interface ImprovementControlResult { readonly control_id: string; readonly status: 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE' | string; readonly reason: string }
export interface ImprovementAssessment { readonly generation_id: string; readonly controls: readonly ImprovementControlResult[]; readonly overall: string; readonly assessed_at: string }
export interface ImprovementEvidence { readonly reconstruction: ImprovementReconstruction; readonly assessment: ImprovementAssessment }

// ---------------------------------------------------------------------------------------------
// Incidents (a live BFF-computed aggregation over real signals — see `apps/tna-control-center/src/incidents.ts`).
// ---------------------------------------------------------------------------------------------
export interface Incident {
  readonly signature: string; readonly type: string; readonly severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  readonly summary: string; readonly subject: string;
  readonly acknowledgment: { readonly acknowledged_by: string; readonly acknowledged_at: string } | null;
}

export const api = {
  login: (username: string, password: string) => request<{ user: SessionUser }>('POST', '/api/session/login', { username, password }),
  logout: () => request<{ loggedOut: true }>('POST', '/api/session/logout'),
  me: () => request<SessionUser>('GET', '/api/session/me'),
  dashboard: () => request<DashboardSummary>('GET', '/api/dashboard'),
  actions: (params: { limit?: number; cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const query = qs.toString();
    return request<ActionsPage>('GET', `/api/actions${query ? `?${query}` : ''}`);
  },
  action: (id: string) => request<Record<string, unknown>>('GET', `/api/actions/${encodeURIComponent(id)}`),
  actionEvidence: (id: string) => request<Record<string, unknown>>('GET', `/api/actions/${encodeURIComponent(id)}/evidence`),
  approveAction: (id: string) => request<Record<string, unknown>>('POST', `/api/actions/${encodeURIComponent(id)}/approve`),
  terminateAction: (id: string, reason: string) => request<Record<string, unknown>>('POST', `/api/actions/${encodeURIComponent(id)}/terminate`, { reason }),

  connections: () => request<readonly McpServerRegistration[]>('GET', '/api/connections'),

  tools: () => request<readonly GovernedTool[]>('GET', '/api/tools'),
  enableTool: (toolId: string, input: { readonly state_version: number; readonly risk_class: string; readonly policy_id: string; readonly allowed_operations: readonly string[]; readonly resource_patterns: readonly string[]; readonly requires_human_approval: boolean; readonly requires_vad: boolean }) =>
    request<Record<string, unknown>>('POST', `/api/tools/${encodeURIComponent(toolId)}/enable`, input),
  disableTool: (toolId: string, stateVersion: number) => request<Record<string, unknown>>('POST', `/api/tools/${encodeURIComponent(toolId)}/disable`, { state_version: stateVersion }),

  evidenceSearch: (params: { correlationId?: string; streamId?: string; eventType?: string; limit?: number; cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.correlationId) qs.set('correlationId', params.correlationId);
    if (params.streamId) qs.set('streamId', params.streamId);
    if (params.eventType) qs.set('eventType', params.eventType);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const query = qs.toString();
    return request<LedgerPage>('GET', `/api/evidence/search${query ? `?${query}` : ''}`);
  },
  evidenceStream: (streamId: string) => request<LedgerPage>('GET', `/api/evidence/streams/${encodeURIComponent(streamId)}`),
  evidenceStreamVerify: (streamId: string) => request<StreamVerificationResult>('GET', `/api/evidence/streams/${encodeURIComponent(streamId)}/verify`),
  evidenceVerifyAll: () => request<FullVerificationResult>('GET', '/api/evidence/verify'),

  assessments: () => request<AuditPage<AssessmentRecord>>('GET', '/api/audit/assessments'),
  assessment: (id: string) => request<AssessmentRecord>('GET', `/api/audit/assessments/${encodeURIComponent(id)}`),
  assessmentResults: (id: string) => request<AuditPage<ControlResult>>('GET', `/api/audit/assessments/${encodeURIComponent(id)}/results`),
  assessmentFindings: (id: string) => request<AuditPage<AuditFinding>>('GET', `/api/audit/assessments/${encodeURIComponent(id)}/findings`),

  identities: () => request<{ items: readonly ServiceIdentity[] }>('GET', '/api/identities'),
  createIdentity: (name: string, role: string) => request<{ identity: ServiceIdentity; credential: { credential_ref: string; token: string } }>('POST', '/api/identities', { name, role }),
  rotateCredential: (serviceId: string, stateVersion: number) => request<{ identity: ServiceIdentity; credential: { credential_ref: string; token: string } }>('POST', `/api/identities/${encodeURIComponent(serviceId)}/rotate`, { state_version: stateVersion }),
  revokeIdentity: (serviceId: string, stateVersion: number) => request<ServiceIdentity>('POST', `/api/identities/${encodeURIComponent(serviceId)}/revoke`, { state_version: stateVersion }),

  improvements: (systemId: string, limit?: number) => {
    const qs = new URLSearchParams({ systemId });
    if (limit) qs.set('limit', String(limit));
    return request<ImprovementGenerationsPage>('GET', `/api/improvements?${qs.toString()}`);
  },
  improvement: (id: string) => request<ImprovementGeneration>('GET', `/api/improvements/${encodeURIComponent(id)}`),
  improvementEvidence: (id: string) => request<ImprovementEvidence>('GET', `/api/improvements/${encodeURIComponent(id)}/evidence`),
  improvementLineage: (id: string) => request<LineageResult>('GET', `/api/improvements/${encodeURIComponent(id)}/lineage`),
  approveImprovement: (id: string, operation: string) => request<{ approval: { approvalId: string } }>('POST', `/api/improvements/${encodeURIComponent(id)}/approve`, { operation }),
  promoteImprovement: (id: string, approvalId?: string) => request<{ decision: { decision: string }; generation: ImprovementGeneration }>('POST', `/api/improvements/${encodeURIComponent(id)}/promote`, approvalId ? { approvalId } : {}),
  rollbackImprovement: (id: string, targetGenerationId: string, approvalId?: string, trigger?: string) =>
    request<{ decision: { decision: string }; generation: ImprovementGeneration; verified?: boolean; reason?: string }>('POST', `/api/improvements/${encodeURIComponent(id)}/rollback`, { targetGenerationId, ...(approvalId ? { approvalId } : {}), ...(trigger ? { trigger } : {}) }),

  incidents: () => request<{ items: readonly Incident[] }>('GET', '/api/incidents'),
  acknowledgeIncident: (signature: string) => request<{ acknowledged: true }>('POST', `/api/incidents/${encodeURIComponent(signature)}/acknowledge`),

  organization: () => request<Record<string, unknown>>('GET', '/api/organization'),
  readiness: () => request<{ tenant_id: string; readiness: string; checks: readonly { check: string; passed: boolean; detail: string }[] }>('GET', '/api/readiness'),
};

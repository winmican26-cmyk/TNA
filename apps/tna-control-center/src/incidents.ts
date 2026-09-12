/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Incident aggregation.
 *
 * Honest scope note: no accepted TNA backend volume has a unified "Incident" abstraction or store — there
 * is no `/v1/incidents` route anywhere in Platform, Client Gateway, Ledger, Auditor, or the Improvement
 * Governor. Per the Volume 13 build order, this module is deliberately "the narrowest evidence-backed
 * aggregation needed": every incident it produces is derived, on each request, from real signals this BFF
 * has already fetched from real backends elsewhere (Platform readiness, Client Gateway connections/tools,
 * Ledger's own whole-tenant integrity verification) — it invents no new backend state and stores nothing
 * about the underlying CONDITION itself. `INCIDENT_SEVERITY` below is the one deterministic, backend-owned
 * mapping every incident's severity is computed from — the frontend never assigns or overrides a severity.
 */

export type IncidentSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type IncidentType =
  | 'COMPONENT_UNAVAILABLE' | 'COMPONENT_DEGRADED' | 'LEDGER_INTEGRITY' | 'SCHEMA_DRIFT'
  | 'CONNECTION_UNREACHABLE' | 'CONNECTION_DISABLED' | 'ACTION_INDETERMINATE';

export interface Incident {
  /** A stable, deterministic identifier for this specific real condition — the key acknowledgment is
   * recorded against. Never a random id: the same real condition, seen again on a later request, must
   * produce the same signature so a prior acknowledgment still matches it. */
  readonly signature: string;
  readonly type: IncidentType;
  readonly severity: IncidentSeverity;
  readonly summary: string;
  /** The real component/tool/connection/action identifier this incident is about — never a display-only
   * fabricated label. */
  readonly subject: string;
}

export interface ComponentHealthInput { readonly component: string; readonly status: string; readonly mandatory?: boolean; readonly message?: string }
export interface ActionInput { readonly platform_action_id: string; readonly state: string }
export interface ConnectionInput { readonly mcp_server_id: string; readonly name: string; readonly status: string }
export interface ToolInput { readonly tool_id: string; readonly external_tool_name: string; readonly review_status: string }

/** Deterministic severity for a component health signal — mandatory components carry more real
 * consequence than optional ones; DEGRADED is real but non-fatal, UNAVAILABLE is a real hard failure. */
function componentSeverity(status: string, mandatory: boolean): IncidentSeverity {
  if (status === 'UNAVAILABLE') return mandatory ? 'CRITICAL' : 'MEDIUM';
  return mandatory ? 'HIGH' : 'LOW'; // DEGRADED or an unrecognized non-AVAILABLE status
}

export function computeIncidents(inputs: {
  readonly components?: readonly ComponentHealthInput[] | undefined;
  readonly actions?: readonly ActionInput[] | undefined;
  readonly connections?: readonly ConnectionInput[] | undefined;
  readonly tools?: readonly ToolInput[] | undefined;
  readonly ledgerVerification?: { readonly valid: boolean; readonly invalidStreams: number } | null | undefined;
}): readonly Incident[] {
  const incidents: Incident[] = [];

  for (const c of inputs.components ?? []) {
    if (c.status === 'AVAILABLE') continue;
    const mandatory = c.mandatory ?? true; // fail toward treating an unlabeled component as mandatory, never the reverse
    incidents.push({
      signature: `component:${c.component}:${c.status}`, type: c.status === 'UNAVAILABLE' ? 'COMPONENT_UNAVAILABLE' : 'COMPONENT_DEGRADED',
      severity: componentSeverity(c.status, mandatory), summary: `${c.component} is ${c.status}${c.message ? ` (${c.message})` : ''}`, subject: c.component,
    });
  }

  if (inputs.ledgerVerification && !inputs.ledgerVerification.valid) {
    incidents.push({
      signature: 'ledger:integrity', type: 'LEDGER_INTEGRITY', severity: 'CRITICAL',
      summary: `Ledger integrity verification found ${inputs.ledgerVerification.invalidStreams} invalid stream(s)`, subject: 'ledger',
    });
  }

  for (const t of inputs.tools ?? []) {
    if (t.review_status !== 'POLICY_REVIEW_REQUIRED') continue;
    incidents.push({
      signature: `schema-drift:${t.tool_id}`, type: 'SCHEMA_DRIFT', severity: 'MEDIUM',
      summary: `Tool "${t.external_tool_name}" contract changed and requires policy review`, subject: t.tool_id,
    });
  }

  for (const c of inputs.connections ?? []) {
    if (c.status === 'UNREACHABLE') incidents.push({ signature: `connection:${c.mcp_server_id}:unreachable`, type: 'CONNECTION_UNREACHABLE', severity: 'HIGH', summary: `Connection "${c.name}" is unreachable`, subject: c.mcp_server_id });
    else if (c.status === 'DISABLED') incidents.push({ signature: `connection:${c.mcp_server_id}:disabled`, type: 'CONNECTION_DISABLED', severity: 'LOW', summary: `Connection "${c.name}" is disabled`, subject: c.mcp_server_id });
  }

  for (const a of inputs.actions ?? []) {
    if (a.state !== 'INDETERMINATE') continue;
    incidents.push({ signature: `action:${a.platform_action_id}:indeterminate`, type: 'ACTION_INDETERMINATE', severity: 'HIGH', summary: `Action ${a.platform_action_id} is in an INDETERMINATE state`, subject: a.platform_action_id });
  }

  const order: Record<IncidentSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return incidents.sort((a, b) => order[a.severity] - order[b.severity]);
}

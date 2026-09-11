import type { LedgerEventInput, AuthorityContext } from '../../../packages/ledger-schema/src/index.js';
import type { SentinelSession, SentinelDecision, Violation, EmergencyStop } from '../../../packages/sentinel-runtime/src/index.js';

/**
 * Maps Sentinel runtime activity into Ledger event inputs (sections 57-58, 101). Pure translation
 * layer — never calls into SentinelRuntime and never alters Ledger's own validation or hash-chain
 * behavior. Uses the `sentinel` source component and the ten `SENTINEL_*` event types added to
 * ledger-schema for this milestone (see packages/ledger-schema/src/index.ts).
 *
 * Stream partitioning: one stream per Sentinel session (`sentinel:<sentinel_session_id>`), so one
 * session's full lifecycle chains together independently of Gate's own `agent:<agentId>` stream.
 * `correlation_id` is the session's bound `decision_id` when one exists, so a Sentinel violation
 * correlates with the Gate decision it was defending — falling back to the session id otherwise.
 */
export class SentinelLedgerAdapter {
  public constructor(private readonly tenantId: string) {}
  private streamOf(sessionId: string): string { return `sentinel:${sessionId}`; }
  private correlationOf(session: SentinelSession): string { return session.decision_id ?? session.sentinel_session_id; }
  private authorityContext(session: SentinelSession): AuthorityContext {
    return { agent_id: session.agent_id, ...(session.decision_id !== undefined ? { decision_id: session.decision_id } : {}), policy_hash: session.policy_snapshot_hash };
  }

  public sessionStarted(session: SentinelSession): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(session.sentinel_session_id)}.SENTINEL_SESSION_STARTED`, event_type: 'SENTINEL_SESSION_STARTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(session.sentinel_session_id), correlation_id: this.correlationOf(session),
      actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel',
      authority_context: this.authorityContext(session), execution_context: { execution_id: session.execution_id },
      payload: { expected_action: session.expected_action, expected_tool: session.expected_tool, expected_resource: session.expected_resource },
    };
  }

  public violationDetected(session: SentinelSession, violation: Violation): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(session.sentinel_session_id)}.SENTINEL_VIOLATION_DETECTED.${violation.violation_id}`, event_type: 'SENTINEL_VIOLATION_DETECTED',
      tenant_id: this.tenantId, stream_id: this.streamOf(session.sentinel_session_id), correlation_id: this.correlationOf(session),
      actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel',
      authority_context: this.authorityContext(session),
      payload: { rule_id: violation.rule_id, rule_type: violation.rule_type, severity: violation.severity, message_code: violation.message_code, message: violation.message, prevention_status: violation.prevention_status },
    };
  }

  private decisionEvent(session: SentinelSession, decision: SentinelDecision, eventType: 'SENTINEL_WARNING' | 'SENTINEL_HOLD' | 'SENTINEL_TERMINATION_REQUESTED' | 'SENTINEL_TERMINATED' | 'SENTINEL_CONTAINMENT_FAILED'): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(session.sentinel_session_id)}.${eventType}.${decision.decision_id}`, event_type: eventType,
      tenant_id: this.tenantId, stream_id: this.streamOf(session.sentinel_session_id), correlation_id: this.correlationOf(session),
      actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel',
      authority_context: this.authorityContext(session),
      payload: { decision: decision.decision, risk_score: decision.risk_score, triggered_rules: decision.triggered_rules, containment_status: decision.containment_status },
    };
  }
  public warning(session: SentinelSession, decision: SentinelDecision): LedgerEventInput { return this.decisionEvent(session, decision, 'SENTINEL_WARNING'); }
  public hold(session: SentinelSession, decision: SentinelDecision): LedgerEventInput { return this.decisionEvent(session, decision, 'SENTINEL_HOLD'); }
  public terminationRequested(session: SentinelSession, decision: SentinelDecision): LedgerEventInput { return this.decisionEvent(session, decision, 'SENTINEL_TERMINATION_REQUESTED'); }
  public terminated(session: SentinelSession, decision: SentinelDecision): LedgerEventInput { return this.decisionEvent(session, decision, 'SENTINEL_TERMINATED'); }
  public containmentFailed(session: SentinelSession, decision: SentinelDecision): LedgerEventInput { return this.decisionEvent(session, decision, 'SENTINEL_CONTAINMENT_FAILED'); }

  public sessionCompleted(session: SentinelSession): LedgerEventInput {
    return {
      version: '1.0', event_id: `${this.streamOf(session.sentinel_session_id)}.SENTINEL_SESSION_COMPLETED`, event_type: 'SENTINEL_SESSION_COMPLETED',
      tenant_id: this.tenantId, stream_id: this.streamOf(session.sentinel_session_id), correlation_id: this.correlationOf(session),
      actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel',
      authority_context: this.authorityContext(session), payload: { status: session.status },
    };
  }

  public emergencyStopActivated(stop: EmergencyStop): LedgerEventInput {
    const streamId = `sentinel-stop:${stop.scope_type}:${stop.scope_value}`;
    return {
      version: '1.0', event_id: `${streamId}.SENTINEL_EMERGENCY_STOP_ACTIVATED.${stop.activated_at}`, event_type: 'SENTINEL_EMERGENCY_STOP_ACTIVATED',
      tenant_id: this.tenantId, stream_id: streamId, correlation_id: streamId,
      actor: { type: 'ADMIN', id: stop.activated_by }, source_component: 'sentinel',
      payload: { scope_type: stop.scope_type, scope_value: stop.scope_value, reason: stop.reason },
    };
  }
  public emergencyStopReleased(stop: EmergencyStop): LedgerEventInput {
    const streamId = `sentinel-stop:${stop.scope_type}:${stop.scope_value}`;
    return {
      version: '1.0', event_id: `${streamId}.SENTINEL_EMERGENCY_STOP_RELEASED.${stop.released_at ?? 'unknown'}`, event_type: 'SENTINEL_EMERGENCY_STOP_RELEASED',
      tenant_id: this.tenantId, stream_id: streamId, correlation_id: streamId,
      actor: { type: 'ADMIN', id: stop.released_by ?? 'unknown' }, source_component: 'sentinel',
      payload: { scope_type: stop.scope_type, scope_value: stop.scope_value },
    };
  }
}

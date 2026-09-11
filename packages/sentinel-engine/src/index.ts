import { randomUUID } from 'node:crypto';
import {
  SentinelError, SEVERITY_SCORE, DECISION_PRECEDENCE, observationPhase,
  type SentinelSession, type SentinelObservation, type AuthorityStatus, type SessionStatus,
  type RuleAction, type Severity, type SentinelDecisionType, type RuleType, type PreventionStatus,
} from '../../sentinel-schema/src/index.js';
import { evaluateRule, type EvaluationContext } from '../../sentinel-signals/src/index.js';
import { type SentinelPolicy, type SentinelRuleInput } from '../../sentinel-policy/src/index.js';

/** Synthetic rule_types for evidence that did not come from the deterministic rule catalog — an
 * active emergency stop (section 50), or an explicit controller-initiated hold/terminate (section
 * 44/48) rather than a rule match. Deliberately not added to sentinel-schema's RULE_TYPES enum, so a
 * tenant policy can never configure behavior "as" one of these. */
export type ViolationRuleType = RuleType | 'EMERGENCY_STOP' | 'MANUAL_CONTROL';

export interface Violation {
  readonly violation_id: string;
  readonly rule_id: string;
  readonly rule_type: ViolationRuleType;
  readonly severity: Severity;
  readonly observed_at: string;
  readonly observation_id: string | null;
  readonly sentinel_session_id: string;
  readonly message_code: string;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  /** Whether the underlying action was stopped before or only detected after it took effect (67-68, 92). */
  readonly prevention_status: PreventionStatus;
}

/** Containment outcome tracking, updated by the runtime after invoking the containment interface (55-56, 68). */
export type ContainmentStatus = 'NOT_REQUIRED' | 'CONTAINMENT_REQUESTED' | 'CONTAINMENT_CONFIRMED' | 'CONTAINMENT_UNCONFIRMED';

/**
 * Machine-readable outcome of reconciling a computed decision against the session's *durable*
 * status at the moment of persistence (concurrency closure, sentinel-v0.1-concurrency-closure.md):
 * - `APPLIED` — the decision's target status was written normally (including a same-status self-loop).
 * - `ESCALATED` — the decision moved the session to a strictly more severe status than it was in.
 * - `NO_OP_ALREADY_STRONGER` — the session's durable status was already at or beyond what this
 *   decision would produce (already terminal, or already mid-termination); nothing was written and
 *   containment was never invoked for this decision.
 * - `STALE` — reserved for a CAS write that lost a race after its own precondition read (should be
 *   unreachable under this runtime's exclusive-transaction locking; see `sentinel-runtime`).
 * `evaluateSession` (pure, no knowledge of concurrency) always sets this to `APPLIED`; the runtime
 * overwrites it with the real reconciled outcome before persisting.
 */
export type TransitionResult = 'APPLIED' | 'ESCALATED' | 'NO_OP_ALREADY_STRONGER' | 'STALE';

export interface SentinelDecision {
  readonly decision_id: string;
  readonly sentinel_session_id: string;
  readonly timestamp: string;
  readonly decision: SentinelDecisionType;
  readonly triggered_rules: readonly string[];
  readonly violations: readonly Violation[];
  readonly risk_score: number;
  readonly policy_hash: string;
  readonly authority_snapshot_hash: string;
  readonly containment_status: ContainmentStatus;
  readonly transition_result: TransitionResult;
}

/** Explicit valid session transitions (section 8). `TERMINATING -> INDETERMINATE` is a deliberate
 * addition beyond the spec's illustrative examples: it is the only mechanism by which containment
 * uncertainty (section 55, 92) can be represented, and self-loops on the three active statuses are
 * legal because repeated CONTINUE/WARN/HOLD decisions are ordinary, expected operation. */
const TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  CREATED: ['MONITORING'],
  MONITORING: ['MONITORING', 'WARNED', 'HELD', 'TERMINATING', 'COMPLETED', 'INDETERMINATE'],
  WARNED: ['WARNED', 'MONITORING', 'HELD', 'TERMINATING'],
  HELD: ['HELD', 'MONITORING', 'TERMINATING'],
  TERMINATING: ['TERMINATED', 'INDETERMINATE'],
  TERMINATED: [],
  COMPLETED: [],
  INDETERMINATE: [],
};
const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set(['TERMINATED', 'COMPLETED', 'INDETERMINATE']);
export function isTerminalStatus(status: SessionStatus): boolean { return TERMINAL_STATUSES.has(status); }

export function assertValidTransition(from: SessionStatus, to: SessionStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new SentinelError('INVALID_TRANSITION', `Invalid session transition: ${from} -> ${to}`);
}

/**
 * Maps a deterministic decision onto the session's next status (section 48-49). A session already
 * HELD does not silently resume to MONITORING merely because a later evaluation computes CONTINUE —
 * only an explicit, trusted `resume()` call may do that; evaluation while HELD can only escalate to
 * TERMINATING.
 */
export function nextStatusForDecision(current: SessionStatus, decision: SentinelDecisionType): SessionStatus {
  if (isTerminalStatus(current)) throw new SentinelError('SESSION_TERMINAL', `Session is in a terminal state (${current}) and cannot be evaluated further`);
  if (decision === 'TERMINATE') return 'TERMINATING';
  if (current === 'HELD') return 'HELD';
  if (decision === 'HOLD') return 'HELD';
  if (decision === 'WARN') return 'WARNED';
  return 'MONITORING';
}

function decidePreventionStatus(observation: SentinelObservation | undefined, action: RuleAction): PreventionStatus {
  if (!observation) return 'DETECTED_AFTER_EFFECT';
  const stopsProgression = action === 'HOLD' || action === 'TERMINATE';
  return stopsProgression && observationPhase(observation.observation_type) === 'PRE_ACTION' ? 'PREVENTED' : 'DETECTED_AFTER_EFFECT';
}
function asDecisionType(action: RuleAction): SentinelDecisionType { return action === 'OBSERVE' ? 'CONTINUE' : action; }
const DECISION_BY_PRECEDENCE: Readonly<Record<number, SentinelDecisionType>> = { 0: 'CONTINUE', 1: 'WARN', 2: 'HOLD', 3: 'TERMINATE' };
function buildViolation(id: string, ruleId: string, ruleType: ViolationRuleType, severity: Severity, now: number, observationId: string | null, sessionId: string, code: string, message: string, evidence: Record<string, unknown>, prevention: PreventionStatus): Violation {
  return { violation_id: id, rule_id: ruleId, rule_type: ruleType, severity, observed_at: new Date(now).toISOString(), observation_id: observationId, sentinel_session_id: sessionId, message_code: code, message, evidence, prevention_status: prevention };
}

export interface EvaluateSessionParams {
  readonly session: SentinelSession;
  readonly policy: SentinelPolicy;
  readonly now: number;
  readonly observation?: SentinelObservation;
  readonly authorityStatus?: AuthorityStatus;
  readonly emergencyStopActive?: boolean;
  readonly newId?: () => string;
}
export interface EvaluateSessionOutcome { readonly decision: SentinelDecision; readonly violations: readonly Violation[]; readonly nextStatus: SessionStatus }

/**
 * Runs every enabled policy rule against one context and folds the results into a single decision
 * (sections 38-41). Deterministic and side-effect-free: given the same session, policy, observation,
 * authority status and clock reading, it always returns the same outcome (TNA-32). Containment is
 * never invoked here — that is the runtime's job once it has this outcome in hand.
 */
export function evaluateSession(params: EvaluateSessionParams): EvaluateSessionOutcome {
  const { session, policy, now, observation, authorityStatus, emergencyStopActive = false, newId = randomUUID } = params;
  if (isTerminalStatus(session.status)) throw new SentinelError('SESSION_TERMINAL', `Session ${session.sentinel_session_id} is in a terminal state (${session.status}) and cannot be evaluated further`);

  const violations: Violation[] = [];
  const triggeredRuleIds: string[] = [];
  let riskScore = 0;
  // Tracked as a precedence number, not the decision literal itself, so this stays a single
  // monotonic `let number` — a decision-typed `let` mutated only through a captured closure defeats
  // TypeScript's narrowing at the read site below.
  let bestPrecedence = DECISION_PRECEDENCE.CONTINUE;
  const escalate = (candidate: SentinelDecisionType): void => { bestPrecedence = Math.max(bestPrecedence, DECISION_PRECEDENCE[candidate]); };

  if (emergencyStopActive) {
    violations.push(buildViolation(newId(), 'emergency-stop', 'EMERGENCY_STOP', 'CRITICAL', now, observation?.observation_id ?? null, session.sentinel_session_id, 'SENTINEL_EMERGENCY_STOP_ACTIVE', 'An active emergency stop scope covers this session', {}, decidePreventionStatus(observation, 'TERMINATE')));
    triggeredRuleIds.push('emergency-stop');
    escalate('TERMINATE');
    riskScore = SEVERITY_SCORE.CRITICAL;
  } else {
    const context: EvaluationContext = { session, now, ...(observation !== undefined ? { observation } : {}), ...(authorityStatus !== undefined ? { authorityStatus } : {}) };
    for (const rule of policy.rules) {
      if (!rule.enabled) continue;
      const outcome = evaluateRule(rule as SentinelRuleInput, context);
      if (outcome.status === 'MATCH') {
        const action = outcome.overrideAction ?? rule.action;
        const severity = outcome.overrideSeverity ?? rule.severity;
        violations.push(buildViolation(newId(), rule.rule_id, rule.rule_type, severity, now, outcome.observation_id ?? null, session.sentinel_session_id, outcome.message_code, outcome.message, outcome.evidence, decidePreventionStatus(observation, action)));
        triggeredRuleIds.push(rule.rule_id);
        escalate(asDecisionType(action));
        riskScore = Math.max(riskScore, SEVERITY_SCORE[severity]);
      } else if (outcome.status === 'ERROR') {
        // Fail-safe (section 70): a rule that could not be evaluated never resolves to silent no-match.
        violations.push(buildViolation(newId(), rule.rule_id, rule.rule_type, 'HIGH', now, observation?.observation_id ?? null, session.sentinel_session_id, `${outcome.message_code}_EVALUATION_ERROR`, outcome.message, outcome.evidence, decidePreventionStatus(observation, 'HOLD')));
        triggeredRuleIds.push(rule.rule_id);
        escalate('HOLD');
        riskScore = Math.max(riskScore, SEVERITY_SCORE.HIGH);
      }
    }
    const thresholds = policy.risk_thresholds;
    if (thresholds) {
      // Escalation-only overlay (documented in sentinel-policy-spec-v1.md): thresholds can raise the
      // decision toward TERMINATE but can never lower what a matched rule already produced.
      if (thresholds.terminate_at !== undefined && riskScore >= thresholds.terminate_at) escalate('TERMINATE');
      if (thresholds.hold_at !== undefined && riskScore >= thresholds.hold_at) escalate('HOLD');
      if (thresholds.warn_at !== undefined && riskScore >= thresholds.warn_at) escalate('WARN');
    }
  }

  const bestDecision = DECISION_BY_PRECEDENCE[bestPrecedence] ?? 'CONTINUE';
  const nextStatus = nextStatusForDecision(session.status, bestDecision);
  const containmentStatus: ContainmentStatus = bestDecision === 'HOLD' || bestDecision === 'TERMINATE' ? 'CONTAINMENT_REQUESTED' : 'NOT_REQUIRED';
  const decision: SentinelDecision = {
    decision_id: newId(), sentinel_session_id: session.sentinel_session_id, timestamp: new Date(now).toISOString(),
    decision: bestDecision, triggered_rules: triggeredRuleIds, violations, risk_score: riskScore,
    policy_hash: policy.policy_hash, authority_snapshot_hash: session.authority_snapshot_hash, containment_status: containmentStatus,
    // Pure computation has no visibility into concurrent durable state; the runtime overwrites this
    // with the real reconciled outcome before persisting (see TransitionResult's doc comment above).
    transition_result: 'APPLIED',
  };
  return { decision, violations, nextStatus };
}

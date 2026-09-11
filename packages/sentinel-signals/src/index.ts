import { isPrivateAddress } from '../../egress-guard/src/index.js';
import { matchesPattern } from '../../vad-core/src/index.js';
import {
  type SentinelSession, type SentinelObservation, type AuthorityStatus, type RuleType, type RuleAction, type Severity, type ObservationType,
} from '../../sentinel-schema/src/index.js';
import { type SentinelRuleInput } from '../../sentinel-policy/src/index.js';

export type RuleResultStatus = 'MATCH' | 'NO_MATCH' | 'NOT_APPLICABLE' | 'ERROR';
export interface RuleResult {
  readonly status: RuleResultStatus;
  readonly rule: SentinelRuleInput;
  readonly message_code: string;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly observation_id?: string;
  /** Set only for the volumetric "approaching threshold" case (section 74): the match is real but the
   * configured rule.action/severity must not apply yet — a fixed, softer WARN/LOW is used instead. */
  readonly overrideAction?: RuleAction;
  readonly overrideSeverity?: Severity;
}

export interface EvaluationContext {
  readonly session: SentinelSession;
  readonly now: number;
  readonly observation?: SentinelObservation;
  readonly authorityStatus?: AuthorityStatus;
}

function messageCode(ruleType: RuleType): string { return `SENTINEL_${ruleType}`; }
function result(status: RuleResultStatus, rule: SentinelRuleInput, message: string, evidence: Record<string, unknown> = {}, observationId?: string, override?: { action?: RuleAction; severity?: Severity }): RuleResult {
  return {
    status, rule, message_code: messageCode(rule.rule_type), message, evidence,
    ...(observationId !== undefined ? { observation_id: observationId } : {}),
    ...(override?.action !== undefined ? { overrideAction: override.action } : {}),
    ...(override?.severity !== undefined ? { overrideSeverity: override.severity } : {}),
  };
}
const noMatch = (rule: SentinelRuleInput, message = 'No violation observed'): RuleResult => result('NO_MATCH', rule, message);
const notApplicable = (rule: SentinelRuleInput, message: string): RuleResult => result('NOT_APPLICABLE', rule, message);

/** Section 89: normalize a hostname before comparison — lowercase, strip a single trailing dot. Not a
 * DNS-rebinding defense (section 90) — see the threat model for that limitation. */
export function normalizeHostname(host: string): string { return host.trim().toLowerCase().replace(/\.$/, ''); }
/** Section 36: strip a Windows executable suffix case-insensitively before comparing to an allowlist. */
export function normalizeProcessName(name: string): string { return name.trim().toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, ''); }

/** Exact match or a single leading `*.` wildcard suffix — the same shape egress-guard's allow-list uses. */
export function hostAllowed(hostname: string, allowList: readonly string[]): boolean {
  const target = normalizeHostname(hostname);
  return allowList.some(entry => {
    const pattern = normalizeHostname(entry);
    return pattern.startsWith('*.') ? target === pattern.slice(2) || target.endsWith(`.${pattern.slice(2)}`) : target === pattern;
  });
}

function str(payload: Record<string, unknown> | undefined, key: string): string | undefined { const v = payload?.[key]; return typeof v === 'string' ? v : undefined; }

const TOOL_CALL_TYPES: readonly ObservationType[] = ['TOOL_CALL_REQUESTED', 'TOOL_CALL_STARTED', 'TOOL_CALL_COMPLETED', 'TOOL_CALL_FAILED'];
const RESOURCE_OP: Readonly<Partial<Record<ObservationType, 'read' | 'write' | 'create' | 'delete'>>> = { RESOURCE_READ: 'read', RESOURCE_WRITE: 'write', RESOURCE_CREATE: 'create', RESOURCE_DELETE: 'delete' };

function volumetric(rule: SentinelRuleInput, count: number, requiredParam: 'max_tool_calls' | 'max_network_requests' | 'max_process_spawns'): RuleResult {
  const max = rule.params?.[requiredParam];
  if (max === undefined) return notApplicable(rule, 'Policy did not configure a threshold for this rule');
  if (count > max) return result('MATCH', rule, `Observed count ${count} exceeds configured maximum ${max}`, { count, max });
  const warn = rule.params?.warning_threshold;
  if (warn !== undefined && count >= warn) return result('MATCH', rule, `Observed count ${count} is approaching configured maximum ${max}`, { count, max, warning_threshold: warn, approaching: true }, undefined, { action: 'WARN', severity: 'LOW' });
  return noMatch(rule);
}

/**
 * Deterministic, side-effect-free evaluation of one rule against one context (section 69). Containment
 * never happens here — this function only classifies. `context.observation` is present for
 * observation-triggered evaluation; several rule types are NOT_APPLICABLE without one.
 */
export function evaluateRule(rule: SentinelRuleInput, context: EvaluationContext): RuleResult {
  const { session, now, observation, authorityStatus } = context;
  const payload = observation?.payload;
  switch (rule.rule_type) {
    case 'AUTHORITY_EXPIRED': {
      const expiry = Date.parse(session.authority_expiry);
      return now > expiry ? result('MATCH', rule, `Authority expired at ${session.authority_expiry}`, { authority_expiry: session.authority_expiry, now }) : noMatch(rule);
    }
    case 'APPROVAL_REVOKED':
    case 'AGENT_REVOKED': {
      const wantScope = rule.rule_type === 'APPROVAL_REVOKED' ? 'approval' : 'agent';
      if (!authorityStatus) return notApplicable(rule, 'No authority recheck is available yet');
      if (authorityStatus.status === 'UNKNOWN') return result('ERROR', rule, 'Authority status could not be established', { authorityStatus });
      if (authorityStatus.status === 'REVOKED' && (authorityStatus.revokedScope ?? 'agent') === wantScope) return result('MATCH', rule, `${wantScope === 'agent' ? 'Agent' : 'Approval'} was revoked during execution`, { authorityStatus });
      return noMatch(rule);
    }
    case 'POLICY_CHANGED': {
      if (!authorityStatus) return notApplicable(rule, 'No policy recheck is available yet');
      if (authorityStatus.status === 'UNKNOWN') return result('ERROR', rule, 'Authority status could not be established', { authorityStatus });
      if (authorityStatus.status === 'POLICY_CHANGED') return result('MATCH', rule, 'Active policy hash no longer matches the session-bound snapshot', { session_policy_hash: session.policy_snapshot_hash, current_policy_hash: authorityStatus.currentPolicyHash ?? null });
      return noMatch(rule);
    }
    case 'TOOL_NOT_ALLOWED': {
      if (!observation || !TOOL_CALL_TYPES.includes(observation.observation_type)) return notApplicable(rule, 'No tool-call observation to evaluate');
      const tool = str(payload, 'tool');
      if (tool === undefined) return notApplicable(rule, 'Observation carried no tool field');
      return tool !== session.expected_tool
        ? result('MATCH', rule, `Observed tool "${tool}" does not match authorized tool "${session.expected_tool}"`, { observed: tool, expected: session.expected_tool }, observation.observation_id)
        : noMatch(rule);
    }
    case 'OPERATION_NOT_ALLOWED': {
      const operation = observation ? RESOURCE_OP[observation.observation_type] : undefined;
      if (!observation || operation === undefined) return notApplicable(rule, 'No resource-operation observation to evaluate');
      return !session.allowed_operations.includes(operation)
        ? result('MATCH', rule, `Observed operation "${operation}" is not in the authorized operation set`, { observed: operation, allowed: session.allowed_operations }, observation.observation_id)
        : noMatch(rule);
    }
    case 'RESOURCE_NOT_ALLOWED': {
      if (!observation) return notApplicable(rule, 'No observation to evaluate');
      const resource = str(payload, 'resource');
      if (resource === undefined) return notApplicable(rule, 'Observation carried no resource field');
      return !matchesPattern(session.expected_resource, resource)
        ? result('MATCH', rule, `Observed resource "${resource}" does not match authorized resource "${session.expected_resource}"`, { observed: resource, expected: session.expected_resource }, observation.observation_id)
        : noMatch(rule);
    }
    case 'DESTINATION_NOT_ALLOWED': {
      if (!observation || observation.observation_type !== 'NETWORK_REQUEST') return notApplicable(rule, 'No network-request observation to evaluate');
      const destination = str(payload, 'destination');
      if (destination === undefined) return notApplicable(rule, 'Observation carried no destination field');
      return !hostAllowed(destination, session.allowed_destinations)
        ? result('MATCH', rule, `Destination "${destination}" is not in the authorized destination set`, { observed: destination, allowed: session.allowed_destinations }, observation.observation_id)
        : noMatch(rule);
    }
    case 'PRIVATE_NETWORK_DESTINATION': {
      if (!observation || (observation.observation_type !== 'NETWORK_REQUEST' && observation.observation_type !== 'NETWORK_REDIRECT')) return notApplicable(rule, 'No network observation to evaluate');
      const destination = str(payload, observation.observation_type === 'NETWORK_REDIRECT' ? 'to' : 'destination');
      const resolvedAddress = str(payload, 'resolved_address');
      const host = resolvedAddress ?? destination;
      if (host === undefined) return notApplicable(rule, 'Observation carried no destination field');
      const hostname = normalizeHostname(host);
      return hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateAddress(hostname)
        ? result('MATCH', rule, `Destination "${host}" resolves to a non-public address range`, { observed: host }, observation.observation_id)
        : noMatch(rule);
    }
    case 'REDIRECT_NOT_ALLOWED': {
      if (!observation || observation.observation_type !== 'NETWORK_REDIRECT') return notApplicable(rule, 'No redirect observation to evaluate');
      const to = str(payload, 'to');
      if (to === undefined) return notApplicable(rule, 'Observation carried no redirect target');
      return !hostAllowed(to, session.allowed_destinations)
        ? result('MATCH', rule, `Redirect target "${to}" is not in the authorized destination set`, { observed: to, allowed: session.allowed_destinations }, observation.observation_id)
        : noMatch(rule);
    }
    case 'RUNTIME_EXCEEDED': {
      const elapsedMs = now - Date.parse(session.started_at);
      const limitMs = session.runtime_limits.max_runtime_seconds * 1000;
      return elapsedMs > limitMs ? result('MATCH', rule, `Elapsed runtime ${Math.round(elapsedMs / 1000)}s exceeds the ${session.runtime_limits.max_runtime_seconds}s limit`, { elapsed_seconds: Math.round(elapsedMs / 1000), max_runtime_seconds: session.runtime_limits.max_runtime_seconds }) : noMatch(rule);
    }
    case 'COST_EXCEEDED': {
      return session.session_cost > session.cost_limits.max_cost_usd
        ? result('MATCH', rule, `Accumulated cost ${session.session_cost} exceeds the ${session.cost_limits.max_cost_usd} limit`, { session_cost: session.session_cost, max_cost_usd: session.cost_limits.max_cost_usd })
        : noMatch(rule);
    }
    case 'TOO_MANY_TOOL_CALLS': return volumetric(rule, session.tool_call_count, 'max_tool_calls');
    case 'TOO_MANY_NETWORK_REQUESTS': return volumetric(rule, session.network_request_count, 'max_network_requests');
    case 'TOO_MANY_PROCESS_SPAWNS': return volumetric(rule, session.process_spawn_count, 'max_process_spawns');
    case 'UNEXPECTED_PROCESS': {
      if (!observation || observation.observation_type !== 'PROCESS_STARTED') return notApplicable(rule, 'No process-start observation to evaluate');
      if (session.allowed_processes === undefined) return notApplicable(rule, 'Session declared no process allowlist');
      const executable = str(payload, 'executable');
      if (executable === undefined) return notApplicable(rule, 'Observation carried no executable field');
      const normalized = normalizeProcessName(executable);
      return !session.allowed_processes.some(allowed => normalizeProcessName(allowed) === normalized)
        ? result('MATCH', rule, `Process "${executable}" is not in the authorized process allowlist`, { observed: executable, allowed: session.allowed_processes }, observation.observation_id)
        : noMatch(rule);
    }
    case 'SECRET_LEASE_NOT_ALLOWED': {
      if (!observation || observation.observation_type !== 'SECRET_LEASE_REQUESTED') return notApplicable(rule, 'No secret-lease observation to evaluate');
      if (session.allowed_secrets === undefined) return notApplicable(rule, 'Session declared no secret allowlist');
      const name = str(payload, 'name');
      if (name === undefined) return notApplicable(rule, 'Observation carried no secret name field');
      return !session.allowed_secrets.includes(name)
        ? result('MATCH', rule, `Secret lease "${name}" is not in the authorized secret allowlist`, { observed: name, allowed: session.allowed_secrets }, observation.observation_id)
        : noMatch(rule);
    }
    case 'TOOL_INPUT_HASH_MISMATCH': {
      if (!observation || !TOOL_CALL_TYPES.includes(observation.observation_type)) return notApplicable(rule, 'No tool-call observation to evaluate');
      if (session.capability_context === undefined) return notApplicable(rule, 'Session declared no capability context');
      const inputHash = str(payload, 'input_hash');
      if (inputHash === undefined) return notApplicable(rule, 'Observation carried no input_hash field');
      return inputHash !== session.capability_context.input_hash
        ? result('MATCH', rule, 'Observed tool input_hash does not match the bound capability context', { observed: inputHash, expected: session.capability_context.input_hash }, observation.observation_id)
        : noMatch(rule);
    }
    case 'CAPABILITY_CONTEXT_MISMATCH': {
      if (!observation) return notApplicable(rule, 'No observation to evaluate');
      const bound = session.capability_context;
      const observedRaw = payload?.capability_context;
      if (bound === undefined || observedRaw === undefined || typeof observedRaw !== 'object' || observedRaw === null) return notApplicable(rule, 'No capability context to compare');
      const observed = observedRaw as Record<string, unknown>;
      const fields: (keyof typeof bound)[] = ['capability_id', 'decision_id', 'agent_id', 'tool', 'operation', 'resource', 'expiry', 'input_hash'];
      const mismatched = fields.filter(field => observed[field] !== undefined && observed[field] !== bound[field]);
      return mismatched.length > 0
        ? result('MATCH', rule, `Observed capability context disagrees with the bound context on: ${mismatched.join(', ')}`, { mismatched, observed, bound }, observation.observation_id)
        : noMatch(rule);
    }
    case 'MISSING_HEARTBEAT': {
      const interval = session.runtime_limits.heartbeat_interval_seconds;
      const grace = session.runtime_limits.heartbeat_grace_seconds;
      if (interval === undefined || grace === undefined) return notApplicable(rule, 'Session declared no heartbeat configuration');
      const lastBeat = Date.parse(session.last_heartbeat_at ?? session.started_at);
      const deadline = lastBeat + (interval + grace) * 1000;
      return now > deadline ? result('MATCH', rule, `No heartbeat observed within ${interval + grace}s`, { last_heartbeat_at: session.last_heartbeat_at ?? session.started_at, deadline: new Date(deadline).toISOString(), now: new Date(now).toISOString() }) : noMatch(rule);
    }
    default: {
      const exhaustive: never = rule.rule_type;
      return notApplicable(rule, `Unimplemented rule type: ${String(exhaustive)}`);
    }
  }
}

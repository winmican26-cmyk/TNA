import {
  SENTINEL_POLICY_VERSION, MAX_RULES_PER_POLICY, SentinelError, RULE_TYPES, RULE_TYPE_SET, RULE_ACTION_SET, SEVERITY_SET,
  isPlainObject, safeId, isIsoTimestamp, canonical, hash, type RuleType, type RuleAction, type Severity,
} from '../../sentinel-schema/src/index.js';

/** Rule-type-specific numeric parameters. Only the volumetric rule types require params (section 33-35). */
export interface RuleParams { max_tool_calls?: number; warning_threshold?: number; max_network_requests?: number; max_process_spawns?: number }
export interface SentinelRuleInput { rule_id: string; rule_type: RuleType; severity: Severity; enabled: boolean; action: RuleAction; params?: RuleParams }

export interface RiskThresholds { warn_at?: number; hold_at?: number; terminate_at?: number }

export interface SentinelPolicyInput {
  version: '1.0';
  policy_id: string;
  tenant_id: string;
  name: string;
  enabled: boolean;
  rules: readonly SentinelRuleInput[];
  default_behavior: RuleAction;
  risk_thresholds?: RiskThresholds;
  effective_at?: string;
  expires_at?: string;
}

/** Fully accepted policy: `created_at`/`policy_hash` are runtime-stamped, never caller-supplied (section 15). */
export interface SentinelPolicy extends SentinelPolicyInput { created_at: string; policy_hash: string }

const RULE_TYPES_REQUIRING_PARAMS: Readonly<Partial<Record<RuleType, keyof RuleParams>>> = {
  TOO_MANY_TOOL_CALLS: 'max_tool_calls',
  TOO_MANY_NETWORK_REQUESTS: 'max_network_requests',
  TOO_MANY_PROCESS_SPAWNS: 'max_process_spawns',
};

function positiveInt(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000; }
function score(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100; }

function validateRule(input: unknown): SentinelRuleInput {
  if (!isPlainObject(input)) throw new SentinelError('POLICY_INVALID', 'Each rule must be an object');
  if (!safeId(input.rule_id, 200)) throw new SentinelError('POLICY_INVALID', 'rule.rule_id is required');
  if (typeof input.rule_type !== 'string' || !RULE_TYPE_SET.has(input.rule_type)) throw new SentinelError('POLICY_INVALID', `Unknown rule_type: ${String(input.rule_type)}`);
  if (typeof input.severity !== 'string' || !SEVERITY_SET.has(input.severity)) throw new SentinelError('POLICY_INVALID', 'rule.severity must be a controlled severity');
  if (typeof input.enabled !== 'boolean') throw new SentinelError('POLICY_INVALID', 'rule.enabled must be a boolean');
  if (typeof input.action !== 'string' || !RULE_ACTION_SET.has(input.action)) throw new SentinelError('POLICY_INVALID', 'rule.action must be a controlled action');
  const ruleType = input.rule_type as RuleType;
  const requiredParam = RULE_TYPES_REQUIRING_PARAMS[ruleType];
  if (requiredParam) {
    if (!isPlainObject(input.params) || !positiveInt(input.params[requiredParam])) {
      throw new SentinelError('POLICY_INVALID', `rule ${String(input.rule_id)} (${ruleType}) requires params.${requiredParam}`);
    }
    if (input.params.warning_threshold !== undefined) {
      if (!positiveInt(input.params.warning_threshold) || input.params.warning_threshold >= (input.params[requiredParam] as number)) {
        throw new SentinelError('POLICY_INVALID', `rule ${String(input.rule_id)} warning_threshold must be a positive integer below ${requiredParam}`);
      }
    }
  }
  const normalized: SentinelRuleInput = {
    rule_id: input.rule_id, rule_type: ruleType, severity: input.severity as Severity, enabled: input.enabled, action: input.action as RuleAction,
  };
  if (isPlainObject(input.params)) (normalized as { params?: RuleParams }).params = input.params as RuleParams;
  return normalized;
}

/** Validates a caller-supplied policy (sections 15-17, 71). Never trusts a caller-supplied hash.
 * Malformed input is rejected wholesale before activation — no partial acceptance. */
export function validatePolicyInput(input: unknown): SentinelPolicyInput {
  if (!isPlainObject(input)) throw new SentinelError('POLICY_INVALID', 'Policy must be an object');
  if (input.version !== SENTINEL_POLICY_VERSION) throw new SentinelError('POLICY_INVALID', `Unsupported policy version: ${String(input.version)}`);
  if (!safeId(input.policy_id, 200)) throw new SentinelError('POLICY_INVALID', 'policy_id is required');
  if (!safeId(input.tenant_id, 100)) throw new SentinelError('POLICY_INVALID', 'tenant_id is required');
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 200) throw new SentinelError('POLICY_INVALID', 'name is required');
  if (typeof input.enabled !== 'boolean') throw new SentinelError('POLICY_INVALID', 'enabled must be a boolean');
  if (!Array.isArray(input.rules) || input.rules.length > MAX_RULES_PER_POLICY) throw new SentinelError('POLICY_INVALID', `rules must be an array of at most ${MAX_RULES_PER_POLICY} entries`);
  const rules = input.rules.map(validateRule);
  const seen = new Set<string>();
  for (const rule of rules) { if (seen.has(rule.rule_id)) throw new SentinelError('POLICY_INVALID', `Duplicate rule_id: ${rule.rule_id}`); seen.add(rule.rule_id); }
  if (typeof input.default_behavior !== 'string' || !RULE_ACTION_SET.has(input.default_behavior)) throw new SentinelError('POLICY_INVALID', 'default_behavior must be a controlled action');
  if (input.risk_thresholds !== undefined) {
    const rt = input.risk_thresholds;
    if (!isPlainObject(rt)) throw new SentinelError('POLICY_INVALID', 'risk_thresholds must be an object');
    for (const key of ['warn_at', 'hold_at', 'terminate_at'] as const) if (rt[key] !== undefined && !score(rt[key])) throw new SentinelError('POLICY_INVALID', `risk_thresholds.${key} must be a number from 0 to 100`);
    const warn = rt.warn_at as number | undefined, holdAt = rt.hold_at as number | undefined, terminateAt = rt.terminate_at as number | undefined;
    if (warn !== undefined && holdAt !== undefined && warn > holdAt) throw new SentinelError('POLICY_INVALID', 'risk_thresholds must be non-decreasing: warn_at <= hold_at <= terminate_at');
    if (holdAt !== undefined && terminateAt !== undefined && holdAt > terminateAt) throw new SentinelError('POLICY_INVALID', 'risk_thresholds must be non-decreasing: warn_at <= hold_at <= terminate_at');
  }
  if (input.effective_at !== undefined && !isIsoTimestamp(input.effective_at)) throw new SentinelError('POLICY_INVALID', 'effective_at must be a valid ISO-8601 UTC timestamp');
  if (input.expires_at !== undefined && !isIsoTimestamp(input.expires_at)) throw new SentinelError('POLICY_INVALID', 'expires_at must be a valid ISO-8601 UTC timestamp');

  const normalized: Record<string, unknown> = { version: SENTINEL_POLICY_VERSION, policy_id: input.policy_id, tenant_id: input.tenant_id, name: input.name, enabled: input.enabled, rules, default_behavior: input.default_behavior };
  if (input.risk_thresholds !== undefined) normalized.risk_thresholds = input.risk_thresholds;
  if (input.effective_at !== undefined) normalized.effective_at = input.effective_at;
  if (input.expires_at !== undefined) normalized.expires_at = input.expires_at;
  return normalized as unknown as SentinelPolicyInput;
}

/** The policy hash covers exactly the caller-meaningful content — never `created_at` (section 15). */
export function computePolicyHash(input: SentinelPolicyInput): string { return hash(input as unknown as Record<string, unknown>); }

/** Stamps a validated policy input into a durable, hashed policy record (section 72: immutable identity). */
export function finalizePolicy(input: SentinelPolicyInput, now: () => number = Date.now): SentinelPolicy {
  return { ...input, created_at: new Date(now()).toISOString(), policy_hash: computePolicyHash(input) };
}

export function findRule(policy: SentinelPolicy, ruleType: RuleType): SentinelRuleInput | null {
  return policy.rules.find(rule => rule.rule_type === ruleType && rule.enabled) ?? null;
}

/** Reference-only default severity/action per rule type, used by the demo/default policy (section 73)
 * and the rule catalog documentation. Not enforced — a tenant policy may configure differently. */
export const RULE_CATALOG_DEFAULTS: Readonly<Record<RuleType, { severity: Severity; action: RuleAction }>> = {
  AUTHORITY_EXPIRED: { severity: 'CRITICAL', action: 'TERMINATE' },
  APPROVAL_REVOKED: { severity: 'CRITICAL', action: 'TERMINATE' },
  AGENT_REVOKED: { severity: 'CRITICAL', action: 'TERMINATE' },
  POLICY_CHANGED: { severity: 'MEDIUM', action: 'HOLD' },
  TOOL_NOT_ALLOWED: { severity: 'HIGH', action: 'TERMINATE' },
  OPERATION_NOT_ALLOWED: { severity: 'HIGH', action: 'TERMINATE' },
  RESOURCE_NOT_ALLOWED: { severity: 'HIGH', action: 'TERMINATE' },
  DESTINATION_NOT_ALLOWED: { severity: 'HIGH', action: 'TERMINATE' },
  PRIVATE_NETWORK_DESTINATION: { severity: 'HIGH', action: 'TERMINATE' },
  REDIRECT_NOT_ALLOWED: { severity: 'HIGH', action: 'TERMINATE' },
  RUNTIME_EXCEEDED: { severity: 'MEDIUM', action: 'HOLD' },
  COST_EXCEEDED: { severity: 'MEDIUM', action: 'HOLD' },
  TOO_MANY_TOOL_CALLS: { severity: 'MEDIUM', action: 'HOLD' },
  TOO_MANY_NETWORK_REQUESTS: { severity: 'MEDIUM', action: 'HOLD' },
  TOO_MANY_PROCESS_SPAWNS: { severity: 'MEDIUM', action: 'HOLD' },
  UNEXPECTED_PROCESS: { severity: 'HIGH', action: 'TERMINATE' },
  SECRET_LEASE_NOT_ALLOWED: { severity: 'HIGH', action: 'TERMINATE' },
  TOOL_INPUT_HASH_MISMATCH: { severity: 'CRITICAL', action: 'TERMINATE' },
  CAPABILITY_CONTEXT_MISMATCH: { severity: 'CRITICAL', action: 'TERMINATE' },
  MISSING_HEARTBEAT: { severity: 'MEDIUM', action: 'HOLD' },
};

/**
 * Safe demo/default policy (section 73). NOT a production posture claim. Enables every rule type at
 * its catalog-default severity/action, with a WARN-level heads-up at 80% of the volumetric maxima.
 */
export function defaultDemoPolicyInput(tenantId: string, policyId = 'default-demo-policy'): SentinelPolicyInput {
  const rules: SentinelRuleInput[] = RULE_TYPES.map(ruleType => {
    const catalog = RULE_CATALOG_DEFAULTS[ruleType];
    const base: SentinelRuleInput = { rule_id: `rule.${ruleType.toLowerCase()}`, rule_type: ruleType, severity: catalog.severity, enabled: true, action: catalog.action };
    if (ruleType === 'TOO_MANY_TOOL_CALLS') return { ...base, params: { max_tool_calls: 10, warning_threshold: 8 } };
    if (ruleType === 'TOO_MANY_NETWORK_REQUESTS') return { ...base, params: { max_network_requests: 20 } };
    if (ruleType === 'TOO_MANY_PROCESS_SPAWNS') return { ...base, params: { max_process_spawns: 5 } };
    return base;
  });
  return { version: SENTINEL_POLICY_VERSION, policy_id: policyId, tenant_id: tenantId, name: 'Default Demo Policy (v0.1, not a production posture)', enabled: true, rules, default_behavior: 'OBSERVE' };
}

export { canonical };

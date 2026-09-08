import { createHash } from 'node:crypto';
import { z } from 'zod';
import { host, id, label, money, operation, resourceKind, timestamp } from '../../shared-schema/src/index.js';

const list = z.array(label).max(1000);
const permissions = z.strictObject({ read: list, write: list });
const violation = z.enum(['block', 'terminate', 'terminate_and_rotate', 'pause_and_escalate']);
export const envelopeSchema = z.strictObject({
  version: z.literal('1.0'),
  agent: z.strictObject({ id, name: label, role: id, owner: id, environment: id, expires_at: timestamp }),
  objective: z.strictObject({ task_id: id, goal: label, allowed_outcomes: list.min(1), forbidden_outcomes: list }),
  resources: z.strictObject({ repositories: permissions, files: permissions, databases: permissions, infrastructure: permissions }),
  tools: z.strictObject({ allow: z.array(id), deny: z.array(id) }),
  network: z.strictObject({ allow: z.array(host), deny: z.array(z.union([host, z.literal('*')])) }),
  secrets: z.strictObject({ allow: z.array(z.strictObject({ name: id, mode: z.literal('ephemeral'), ttl_seconds: z.number().int().positive().max(86400) })), deny: list }),
  agents: z.strictObject({ communicate_with: z.array(id), communication_mode: z.literal('authenticated'), shared_memory: z.literal(false), deny_unknown_agents: z.literal(true) }),
  limits: z.strictObject({ max_runtime_seconds: z.number().int().positive().max(86400), max_tool_calls: z.number().int().positive(), max_external_requests: z.number().int().nonnegative(), max_cost_usd: money, max_retries_per_action: z.number().int().nonnegative() }),
  approvals: z.strictObject({ required_for: z.array(z.strictObject({ action: id, approver_role: id })) }),
  risk: z.strictObject({ level: z.enum(['low', 'medium', 'high', 'critical']), blast_radius: label, rollback_required: z.boolean() }),
  evidence: z.strictObject({ capture: z.array(z.enum(['agent_identity', 'policy_hash', 'tool_calls', 'network_destinations', 'resources_read', 'resources_modified', 'secrets_accessed', 'approvals', 'verifier_verdict', 'cost', 'timestamps'])), retention_days: z.number().int().positive() }),
  violation_policy: z.strictObject({ unknown_tool: violation, undeclared_resource: violation, unauthorized_agent_contact: violation, network_violation: violation, secret_violation: violation, cost_limit_exceeded: violation, runtime_limit_exceeded: violation }),
  action_bindings: z.array(z.strictObject({
    action: id, outcome: label, tool: id, resource_kind: resourceKind, operation,
    destination_required: z.boolean(),
  })).min(1).max(1000),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const binding of value.action_bindings) {
    const validOperation = binding.resource_kind === 'secrets' ? binding.operation === 'access'
      : binding.resource_kind === 'agents' ? binding.operation === 'communicate'
        : ['read', 'write'].includes(binding.operation);
    if (seen.has(binding.action) || !validOperation || !value.objective.allowed_outcomes.includes(binding.outcome)
      || value.objective.forbidden_outcomes.includes(binding.outcome)
      || !value.tools.allow.includes(binding.tool) || value.tools.deny.includes(binding.tool)
      || binding.action.startsWith('envelope.') || binding.action.startsWith('agent.register')) {
      ctx.addIssue({ code: 'custom', message: 'Invalid, duplicate, forbidden, or inconsistent action binding', path: ['action_bindings'] });
    }
    seen.add(binding.action);
  }
  const approvals = new Set<string>();
  for (const rule of value.approvals.required_for) {
    if (!seen.has(rule.action) || approvals.has(rule.action)) ctx.addIssue({ code: 'custom', message: 'Approval must refer to one unique bound action', path: ['approvals'] });
    approvals.add(rule.action);
  }
  for (const pattern of [...value.resources.files.read, ...value.resources.files.write]) {
    if (!validFile(pattern.replace(/\/\*\*$/, ''))) ctx.addIssue({ code: 'custom', message: 'File scopes must be canonical absolute POSIX paths, optionally ending in /**', path: ['resources', 'files'] });
  }
});
export type Envelope = z.infer<typeof envelopeSchema>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => JSON.stringify(key) + ':' + canonical(val)).join(',') + '}';
  return JSON.stringify(value);
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function validFile(path: string): boolean {
  return path.startsWith('/') && !/[\\%*]/.test(path)
    && !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    && path.split('/').slice(1).every(part => part !== '' && part !== '.' && part !== '..');
}
export function matchesResource(resource: string, patterns: string[], files: boolean): boolean {
  if (files && !validFile(resource)) return false;
  return patterns.some(pattern => files && pattern.endsWith('/**')
    ? resource.startsWith(pattern.slice(0, -2)) : resource === pattern);
}

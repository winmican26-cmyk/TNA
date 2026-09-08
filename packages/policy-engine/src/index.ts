import type { Envelope } from '../../authority-envelope/src/index.js';
import { matchesResource } from '../../authority-envelope/src/index.js';
import type { AuthorizationRequest } from '../../shared-schema/src/index.js';

export type Usage = { startedAt: string | null; calls: number; external: number; costMicros: number; attempts: Record<string, number> };
export type PolicyContext = { now: number; revoked: boolean; usage: Usage; approvalValid: boolean; knownAgents: ReadonlySet<string> };
export type Verdict = { decision: 'ALLOW' | 'BLOCK' | 'HOLD'; reason: string };
export function micros(amount: number): number { return Math.round(amount * 1_000_000); }
export function attemptsFor(usage: Usage, action: string): number {
  return Object.hasOwn(usage.attempts, action) ? usage.attempts[action]! : 0;
}
export function evaluate(request: AuthorizationRequest, envelope: Envelope | null, context: PolicyContext): Verdict {
  const block = (reason: string): Verdict => ({ decision: 'BLOCK', reason });
  if (context.revoked) return block('Agent has been revoked');
  if (!envelope) return block('No authority envelope');
  if (envelope.agent.id !== request.agentId) return block('Agent identity mismatch');
  if (Date.parse(envelope.agent.expires_at) <= context.now) return block('Envelope expired');
  const binding = envelope.action_bindings.find(b => b.action === request.action);
  if (!binding) return block('Action is outside the stated objective');
  if (binding.tool !== request.tool || !envelope.tools.allow.includes(request.tool) || envelope.tools.deny.includes(request.tool)) return block(`Tool ${request.tool} is not permitted`);
  if (binding.resource_kind === 'secrets') {
    // Credential issuance and rotation are deliberately deferred. Fail closed until a broker exists.
    return block('Secret access requires an ephemeral credential broker (not enabled in v0.1)');
  } else if (binding.resource_kind === 'agents') {
    if (!context.knownAgents.has(request.resource) || !envelope.agents.communicate_with.includes(request.resource)) return block('Unauthorized agent communication');
  } else {
    if (binding.operation !== 'read' && binding.operation !== 'write') return block('Invalid resource operation');
    if (!matchesResource(request.resource, envelope.resources[binding.resource_kind][binding.operation], binding.resource_kind === 'files')) return block('Undeclared resource or operation');
  }
  if (binding.destination_required && !request.destination) return block('Destination is required for this action');
  if (request.destination && (!envelope.network.allow.includes(request.destination) || envelope.network.deny.filter(x => x !== '*').includes(request.destination))) return block('Unauthorized network destination');
  const limits = envelope.limits;
  const usage = context.usage;
  if (usage.startedAt && context.now - Date.parse(usage.startedAt) >= limits.max_runtime_seconds * 1000) return block('Runtime limit exceeded');
  if (usage.calls >= limits.max_tool_calls) return block('Tool-call limit exceeded');
  if (request.destination && usage.external >= limits.max_external_requests) return block('External-request limit exceeded');
  if (usage.costMicros + micros(request.estimatedCostUsd) > micros(limits.max_cost_usd)) return { decision: 'HOLD', reason: 'Cost limit exceeded' };
  if (attemptsFor(usage, request.action) >= 1 + limits.max_retries_per_action) return block('Retry limit exceeded');
  if (envelope.approvals.required_for.some(rule => rule.action === request.action) && !context.approvalValid) return { decision: 'HOLD', reason: 'Valid approval required' };
  return { decision: 'ALLOW', reason: 'Action permitted by envelope' };
}

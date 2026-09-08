import { z } from 'zod';

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const label = z.string().min(1).max(512);
export const timestamp = z.iso.datetime({ offset: true });
export const host = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export const money = z.number().finite().nonnegative().max(1_000_000).multipleOf(0.000001);
export const resourceKind = z.enum(['repositories', 'files', 'databases', 'infrastructure', 'secrets', 'agents']);
export const operation = z.enum(['read', 'write', 'access', 'communicate']);
export const requestSchema = z.strictObject({
  agentId: id, action: id, tool: id, resource: label,
  destination: host.optional(), estimatedCostUsd: money,
  approvalId: id.optional(),
});
export type AuthorizationRequest = z.infer<typeof requestSchema>;
export const registrationSchema = z.strictObject({ id, name: label });
export const approvalSchema = z.strictObject({
  request: requestSchema.omit({ approvalId: true }), expiresAt: timestamp,
});
export const revokeSchema = z.strictObject({ agentId: id, reason: label });
export type Decision = {
  decisionId: string; agentId: string; decision: 'ALLOW' | 'BLOCK' | 'HOLD';
  reason: string; severity: 'info' | 'high'; policyVersion: string | null;
  policyHash: string | null; requiresEvidence: true; timestamp: string;
  request: AuthorizationRequest; approvalReference: string | null;
};

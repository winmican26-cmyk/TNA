import { equalToken } from '../../../packages/agent-identity/src/index.js';
import { agentPrincipal, operatorPrincipal, adminPrincipal, servicePrincipal, type PlatformPrincipal } from '../../../packages/platform-schema/src/index.js';

/**
 * Fixed service/operator/admin identities plus a small agent-token map (section 46, 50). A governed
 * agent's bearer token resolves only to the one `agentId` it was issued for — never to another
 * agent's identity, and never to operator/admin authority (section 12: "An agent may request an
 * action. It may not decide its result.").
 */
export interface PlatformCredentials {
  readonly agentTokens: Readonly<Record<string, string>>; // token -> agentId
  readonly operatorToken: string;
  readonly adminToken: string;
  readonly serviceToken: string;
}

export function validateCredentials(c: PlatformCredentials): void {
  const tokens = [...Object.keys(c.agentTokens), c.operatorToken, c.adminToken, c.serviceToken];
  if (tokens.some(t => t.length < 32) || new Set(tokens).size !== tokens.length) {
    throw new Error('Platform credentials must be distinct and at least 32 characters');
  }
}

export function principalFor(token: string, c: PlatformCredentials, tenantId: string): PlatformPrincipal | null {
  if (equalToken(token, c.adminToken)) return adminPrincipal('platform-admin', tenantId);
  if (equalToken(token, c.operatorToken)) return operatorPrincipal('platform-operator', tenantId);
  if (equalToken(token, c.serviceToken)) return servicePrincipal('platform-service', tenantId);
  for (const [agentToken, agentId] of Object.entries(c.agentTokens)) if (equalToken(token, agentToken)) return agentPrincipal(`platform-agent-${agentId}`, tenantId, agentId);
  return null;
}

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12). Configuration for the improvement governor app.
 * Follows the same pattern as `apps/tna-client-gateway/src/config.ts` — a single validated load from
 * environment variables, failing closed on anything missing.
 */

export interface ImprovementGovernorConfig {
  readonly adminToken: string;
  readonly dbPath: string;
  readonly gatePath: string;
  readonly ledgerPath: string;
  readonly sentinelPath: string;
  readonly port: number;
  readonly host: string;
  readonly tenantId: string;
  readonly approverRole: string;
  readonly governorAgentId: string;
}

export function loadImprovementGovernorConfig(env: NodeJS.ProcessEnv = process.env): ImprovementGovernorConfig {
  const adminToken = env.TNA_IMPROVEMENT_ADMIN_TOKEN ?? '';
  if (adminToken.length < 32) throw new Error('TNA_IMPROVEMENT_ADMIN_TOKEN must be set and at least 32 characters');
  const dbPath = env.TNA_IMPROVEMENT_DB_PATH ?? 'data/improvement.sqlite';
  const gatePath = env.TNA_IMPROVEMENT_GATE_DB_PATH ?? 'data/improvement-gate.sqlite';
  const ledgerPath = env.TNA_IMPROVEMENT_LEDGER_DB_PATH ?? 'data/improvement-ledger.sqlite';
  const sentinelPath = env.TNA_IMPROVEMENT_SENTINEL_DB_PATH ?? 'data/improvement-sentinel.sqlite';
  const portRaw = env.TNA_IMPROVEMENT_PORT ?? '4718';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`TNA_IMPROVEMENT_PORT must be a valid port number, got: ${portRaw}`);
  const host = env.TNA_IMPROVEMENT_HOST ?? '127.0.0.1';
  const tenantId = env.TNA_IMPROVEMENT_TENANT_ID ?? '';
  if (tenantId.length === 0) throw new Error('TNA_IMPROVEMENT_TENANT_ID must be set');
  const approverRole = env.TNA_IMPROVEMENT_APPROVER_ROLE ?? 'improvement-approver';
  const governorAgentId = env.TNA_IMPROVEMENT_GOVERNOR_AGENT_ID ?? 'improvement-governor';
  return { adminToken, dbPath, gatePath, ledgerPath, sentinelPath, port, host, tenantId, approverRole, governorAgentId };
}

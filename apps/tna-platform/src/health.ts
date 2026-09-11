import { runProbe, aggregateReadiness, liveness, type ComponentHealth, type ReadinessResult, type LivenessResult } from '../../../packages/deployment-health/src/index.js';
import type { Gate } from '../../tna-gate-api/src/gate.js';
import type { SentinelRuntime, SentinelPrincipal } from '../../../packages/sentinel-runtime/src/index.js';
import type { LedgerStore } from '../../../packages/ledger-core/src/index.js';
import type { PlatformStore } from '../../../packages/platform-core/src/index.js';
import type { AuditorRuntime, AuditorPrincipal } from '../../../packages/auditor-engine/src/index.js';

/**
 * Section 31-33: readiness assesses the platform's own mandatory dependencies (its own store, Gate,
 * Sentinel, Ledger reachability). Auditor is intentionally optional here — it is post-hoc and never in
 * the critical execution path (TNA-43), so its outage degrades governance-audit availability without
 * blocking ordinary governed-action readiness.
 */
export interface HealthDeps {
  readonly store: PlatformStore;
  readonly tenantId: string;
  readonly gate: Gate;
  readonly sentinel: SentinelRuntime;
  readonly sentinelHealthPrincipal: SentinelPrincipal;
  readonly ledgerStore: LedgerStore;
  readonly auditor?: { readonly runtime: AuditorRuntime; readonly principal: AuditorPrincipal };
}

export function getLiveness(startedAt: number): LivenessResult { return liveness(startedAt); }

export async function getReadiness(deps: HealthDeps): Promise<ReadinessResult> {
  const components: ComponentHealth[] = await Promise.all([
    runProbe('platform_store', true, () => deps.store.list(deps.tenantId, { limit: 1 })),
    runProbe('gate', true, () => deps.gate.isAgentRevoked('__health_check__')),
    runProbe('sentinel', true, () => deps.sentinel.getActivePolicy(deps.sentinelHealthPrincipal)),
    runProbe('ledger', true, () => deps.ledgerStore.listAllStreams()),
    ...(deps.auditor ? [runProbe('auditor', false, () => deps.auditor?.runtime.listAssessments(deps.auditor.principal, 1))] : []),
  ]);
  return aggregateReadiness(components);
}

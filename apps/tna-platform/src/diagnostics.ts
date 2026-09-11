import { COMPONENT_VERSIONS } from '../../../packages/deployment-ops/src/index.js';
import type { MetricsRegistry } from '../../../packages/deployment-health/src/index.js';
import type { PlatformStore } from '../../../packages/platform-core/src/index.js';

/**
 * Section 64, 21, 34: a safe operator-diagnostics surface. Deliberately narrower than a raw config
 * dump — component versions, database availability (already proven by the caller reaching this route
 * at all), and bounded outbox counts. No credential, no secret reference, no raw request/action input
 * ever appears here.
 */
export interface DiagnosticsPayload {
  readonly component_versions: Readonly<Record<string, string>>;
  readonly config_hash: string;
  readonly deployment_id: string;
  readonly outbox_pending: number;
  readonly outbox_dead_letter: number;
  readonly readiness_status: string;
}

export function buildDiagnostics(store: PlatformStore, tenantId: string, configHash: string, deploymentId: string, readinessStatus: string): DiagnosticsPayload {
  const outbox = store.listOutbox(tenantId);
  return {
    component_versions: COMPONENT_VERSIONS,
    config_hash: configHash,
    deployment_id: deploymentId,
    outbox_pending: outbox.filter(o => o.status === 'PENDING' || o.status === 'DELIVERING' || o.status === 'FAILED').length,
    outbox_dead_letter: outbox.filter(o => o.status === 'DEAD_LETTER').length,
    readiness_status: readinessStatus,
  };
}

/** Section 65: read-only dead-letter inspection. Deliberately has no "force mark delivered" mutation —
 * only a real manual retry (re-queuing through the ordinary claim/delivery path, preserving the
 * original `event_id`/causal metadata) is ever offered, never a fabricated acknowledgement. */
export function listDeadLetters(store: PlatformStore, tenantId: string): readonly unknown[] {
  return store.listOutbox(tenantId).filter(o => o.status === 'DEAD_LETTER');
}

export function refreshOutboxGauges(metrics: MetricsRegistry, store: PlatformStore, tenantId: string): void {
  const outbox = store.listOutbox(tenantId);
  metrics.set('outbox_pending', outbox.filter(o => o.status === 'PENDING' || o.status === 'DELIVERING' || o.status === 'FAILED').length);
  metrics.set('outbox_dead_letter', outbox.filter(o => o.status === 'DEAD_LETTER').length);
}

import { randomUUID } from 'node:crypto';
import { improvementWriter } from '../../../apps/tna-ledger/src/writers.js';
import type { Ledger } from '../../../packages/ledger-core/src/index.js';
import type { LedgerEventType } from '../../../packages/ledger-schema/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section F: real Ledger integration. Every
 * improvement generation's lifecycle is appended as real, hash-chained Ledger events under the additive
 * `IMPROVEMENT_*`/`CAPABILITY_DELTA_DETECTED`/`AUTHORITY_EXPANSION_*`/`RECURSION_BUDGET_EXHAUSTED` event
 * types (`packages/ledger-schema`) and the additive `'improvement-governance'` source component, using
 * the additive `improvementWriter()` identity (`apps/tna-ledger/src/writers.ts`) — the exact same
 * "each volume adds its own writer, additively" pattern Sentinel/Auditor/Platform already established.
 * Every event for one generation shares `stream_id: improvement:<generation_id>`, so the full per
 * -generation history is reconstructible from Ledger alone (section G) without ever consulting
 * `ImprovementStore`.
 */

export interface ImprovementLedgerEventInput {
  readonly generationId: string;
  readonly correlationId: string;
  readonly parentGenerationId?: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Appends one real Ledger event for a generation. `payload.generation_id`/`payload.parent_generation_id`
 * are always included so a reconstruction can walk generation lineage from the Ledger's own event
 * content alone (section G) — never a fabricated cross-reference maintained outside the Ledger. */
export function appendImprovementEvent(ledger: Ledger, tenantId: string, eventType: LedgerEventType, input: ImprovementLedgerEventInput) {
  return ledger.append(improvementWriter(tenantId), {
    version: '1.0', event_id: `evt_${randomUUID()}`, event_type: eventType, tenant_id: tenantId,
    stream_id: `improvement:${input.generationId}`, correlation_id: input.correlationId,
    actor: { type: 'SYSTEM', id: 'improvement-governor' }, source_component: 'improvement-governance',
    payload: { generation_id: input.generationId, parent_generation_id: input.parentGenerationId ?? null, ...input.payload },
  });
}

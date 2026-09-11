import { LedgerStore, Ledger, writerPrincipal, readerPrincipal, adminPrincipal, type LedgerPrincipal } from '../../packages/ledger-core/src/index.js';
import type { LedgerEventInput } from '../../packages/ledger-schema/src/index.js';

export function setup(tenantId = 'tenant_demo') {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const gw: LedgerPrincipal = writerPrincipal('ledger-writer-gate', tenantId, ['tna-gate', 'execution-broker', 'isolation-runner']);
  const vw: LedgerPrincipal = writerPrincipal('ledger-writer-vad', tenantId, ['vad-engine', 'human-decision-service']);
  const rd: LedgerPrincipal = readerPrincipal('ledger-reader', tenantId);
  const ad: LedgerPrincipal = adminPrincipal('ledger-admin', tenantId);
  return { store, ledger, gw, vw, rd, ad, tenantId };
}

/** A minimal, structurally valid event. Callers override fields per test. */
export function baseEvent(overrides: Partial<LedgerEventInput> & { tenant_id: string }): LedgerEventInput {
  return {
    version: '1.0',
    event_id: overrides.event_id ?? `evt-${Math.random().toString(36).slice(2)}`,
    event_type: overrides.event_type ?? 'AGENT_REGISTERED',
    tenant_id: overrides.tenant_id,
    stream_id: overrides.stream_id ?? 'agent:a1',
    actor: overrides.actor ?? { type: 'SYSTEM', id: 'tna-gate' },
    correlation_id: overrides.correlation_id ?? 'agent:a1',
    source_component: overrides.source_component ?? 'tna-gate',
    ...(overrides.causation_id !== undefined ? { causation_id: overrides.causation_id } : {}),
    ...(overrides.authority_context !== undefined ? { authority_context: overrides.authority_context } : {}),
    ...(overrides.spec_context !== undefined ? { spec_context: overrides.spec_context } : {}),
    ...(overrides.execution_context !== undefined ? { execution_context: overrides.execution_context } : {}),
    ...(overrides.artifact_context !== undefined ? { artifact_context: overrides.artifact_context } : {}),
    ...(overrides.payload !== undefined ? { payload: overrides.payload } : {}),
    ...(overrides.occurred_at !== undefined ? { occurred_at: overrides.occurred_at } : {}),
  };
}

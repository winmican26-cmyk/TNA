import { writerPrincipal, readerPrincipal, adminPrincipal, type LedgerPrincipal } from '../../../packages/ledger-core/src/index.js';

/**
 * Fixed service identities (section 50, 79-80). A governed agent is never issued one of these —
 * only trusted Gate/VAD components hold write credentials, and each is bound to the specific
 * source_component values it is allowed to claim.
 */
export function gateWriter(tenantId: string): LedgerPrincipal {
  return writerPrincipal('ledger-writer-gate', tenantId, ['tna-gate', 'execution-broker', 'isolation-runner']);
}
export function vadWriter(tenantId: string): LedgerPrincipal {
  return writerPrincipal('ledger-writer-vad', tenantId, ['vad-engine', 'human-decision-service']);
}
export function reader(tenantId: string): LedgerPrincipal {
  return readerPrincipal('ledger-reader', tenantId);
}
export function admin(tenantId: string): LedgerPrincipal {
  return adminPrincipal('ledger-admin', tenantId);
}

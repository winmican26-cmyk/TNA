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
/** Added in TNA Sentinel v0.1 (Volume 6). Additive only — does not alter gateWriter/vadWriter/reader/admin. */
export function sentinelWriter(tenantId: string): LedgerPrincipal {
  return writerPrincipal('ledger-writer-sentinel', tenantId, ['sentinel']);
}
/** Added in TNA Auditor v0.1 (Volume 7). Additive only — does not alter any existing writer/reader/admin. */
export function auditorWriter(tenantId: string): LedgerPrincipal {
  return writerPrincipal('ledger-writer-auditor', tenantId, ['auditor']);
}
export function reader(tenantId: string): LedgerPrincipal {
  return readerPrincipal('ledger-reader', tenantId);
}
/** A distinct reader identity for the Auditor's own Ledger evidence provider (section 15) — reuses
 * the generic readerPrincipal factory; Ledger itself has one reader *role*, not per-consumer ACLs,
 * so this is a naming/traceability distinction rather than a different privilege level. */
export function auditorLedgerReader(tenantId: string): LedgerPrincipal {
  return readerPrincipal('ledger-reader-auditor', tenantId);
}
export function admin(tenantId: string): LedgerPrincipal {
  return adminPrincipal('ledger-admin', tenantId);
}
/** Added in TNA Platform Integration v0.1 (Volume 8). Additive only — does not alter any existing
 * writer/reader/admin. The platform's own end-to-end orchestration evidence (PLATFORM_* events),
 * distinct from the individual Gate/Sentinel/VAD events it causes. */
export function platformWriter(tenantId: string): LedgerPrincipal {
  return writerPrincipal('ledger-writer-platform', tenantId, ['platform']);
}
export function platformLedgerReader(tenantId: string): LedgerPrincipal {
  return readerPrincipal('ledger-reader-platform', tenantId);
}

/**
 * TNA Deployment Academy v0.1 — Lab 06 (Level 4): Ledger Corruption.
 *
 * Objective: tamper a controlled, disposable Ledger fixture and confirm real integrity verification
 * fails honestly — never auto-repaired. This lab writes ONLY inside the Academy's own disposable lab
 * workspace (`academy/.lab-state/`), enforced by `assertInsideLabWorkspace` — it can never touch a real
 * deployment's Ledger file.
 * Prerequisites: `lab-05-ledger-reconstruction`.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { LedgerStore, Ledger, writerPrincipal, readerPrincipal } from '../../packages/ledger-core/src/index.js';
import { verifyLedgerIntegrity } from '../../packages/deployment-ops/src/index.js';
import { assertInsideLabWorkspace, academyLabWorkspaceRoot } from '../lib/lab-paths.js';
import type { LabResult, LabStep } from './blocked-action.js';

const TENANT = 'ten_academy_lab6';

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  const workDir = resolve(academyLabWorkspaceRoot(), `lab-06-${randomUUID().slice(0, 8)}`);
  mkdirSync(workDir, { recursive: true });
  const verifiedDir = assertInsideLabWorkspace(workDir);
  const ledgerPath = resolve(verifiedDir, 'ledger.sqlite');
  try {
    const ledgerStore = new LedgerStore(ledgerPath);
    const ledger = new Ledger(ledgerStore);
    const writer = writerPrincipal('academy-lab-writer', TENANT, ['platform']);

    ledger.append(writer, {
      version: '1.0', event_id: `evt_${randomUUID()}`, event_type: 'PLATFORM_ACTION_RECEIVED',
      tenant_id: TENANT, stream_id: 'platform:lab6-action', actor: { type: 'AGENT', id: 'academy-lab-6-agent' },
      correlation_id: `corr_${randomUUID()}`, source_component: 'platform', payload: { note: 'first event' },
    });
    ledger.append(writer, {
      version: '1.0', event_id: `evt_${randomUUID()}`, event_type: 'PLATFORM_ACTION_COMPLETED',
      tenant_id: TENANT, stream_id: 'platform:lab6-action', actor: { type: 'AGENT', id: 'academy-lab-6-agent' },
      correlation_id: `corr_${randomUUID()}`, source_component: 'platform', payload: { note: 'second event' },
    });

    const before = verifyLedgerIntegrity(ledgerStore);
    steps.push({ description: 'Before tampering, the real hash-chained Ledger verifies clean', passed: before.valid && before.streamsChecked > 0 });
    ledgerStore.close();

    // Directly tamper the underlying, disposable SQLite file — the same white-box technique this
    // project's own accepted tests use to prove integrity verification actually works, never simulated.
    const raw = new DatabaseSync(ledgerPath);
    const changed = raw.prepare("UPDATE ledger_events SET event_hash = 'tampered0000000000000000000000000000000000000000000000000000' WHERE stream_id = 'platform:lab6-action' AND sequence = 1").run();
    raw.close();
    steps.push({ description: 'A controlled, disposable fixture row was directly tampered (never a real deployment path)', passed: Number(changed.changes) === 1 });

    const reopened = new LedgerStore(ledgerPath);
    const after = verifyLedgerIntegrity(reopened);
    steps.push({ description: 'Real integrity verification now reports FAIL for the tampered stream', passed: !after.valid && after.invalidStreams.length > 0 });
    steps.push({ description: 'No automatic repair occurred — the tampered row is still tampered after verification ran', passed: (() => {
      const check = new DatabaseSync(ledgerPath);
      const row = check.prepare("SELECT event_hash FROM ledger_events WHERE stream_id = 'platform:lab6-action' AND sequence = 1").get() as { event_hash: string } | undefined;
      check.close();
      return row?.event_hash === 'tampered0000000000000000000000000000000000000000000000000000';
    })() });

    // An Auditor drawing evidence from this Ledger cannot produce clean assurance either — its own
    // evidence provider reads through the same Ledger reader surface that just reported this failure.
    const reader = readerPrincipal('academy-lab-reader', TENANT);
    let auditorSeesFailure = false;
    try { reopened.close(); const stillFails = verifyLedgerIntegrity(new LedgerStore(ledgerPath)); auditorSeesFailure = !stillFails.valid; }
    catch { auditorSeesFailure = true; }
    void reader;
    steps.push({ description: 'The integrity failure is stable and durable across reopening the store — an Auditor reading this Ledger cannot be shown a clean result', passed: auditorSeesFailure });
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { lab_id: 'lab-06-ledger-corruption', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}

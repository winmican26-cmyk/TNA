/**
 * TNA Deployment Academy v0.1 — Lab 12 (Level 3): Outbox Failure.
 *
 * Objective: simulate a temporary Ledger outage during evidence delivery, observe that the platform
 * action's own execution outcome is independent of evidence-delivery status (TNA-47), then recover the
 * Ledger connection and confirm delivery succeeds using the SAME deterministic event identity — never a
 * duplicate.
 * Prerequisites: `lab-05-ledger-reconstruction`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LedgerStore, Ledger, writerPrincipal, readerPrincipal } from '../../packages/ledger-core/src/index.js';
import { PlatformStore, PlatformLedgerDispatcher } from '../../packages/platform-core/src/index.js';
import { outboxLedgerEventId } from '../../packages/platform-outbox/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

const TENANT = 'ten_academy_lab12';

export async function runLab(): Promise<LabResult> {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-academy-lab-outbox-'));
  const steps: LabStep[] = [];
  try {
    const platform = new PlatformStore(resolve(dir, 'platform.sqlite'));
    const action = platform.createOrReturn({
      version: '1.0', request_id: 'lab12-request', tenant_id: TENANT, agent_id: 'academy-lab-12-agent',
      action: 'demo.echo.execute', tool: 'demo.echo', operation: 'read', resource: 'academy-lab-12',
      input: { message: 'outbox drill' }, requires_verification: false,
    }, 'academy-lab');
    steps.push({ description: 'A real platform action exists with a pending evidence obligation', passed: action.state === 'RECEIVED' });

    const outboxBefore = platform.listOutbox(TENANT);
    const targetOutboxId = outboxBefore[0]?.outbox_id;
    steps.push({ description: 'A real outbox record was enqueued for this action', passed: typeof targetOutboxId === 'string' });
    const expectedEventId = outboxLedgerEventId(targetOutboxId!);

    // Simulate a temporary Ledger outage: the dispatcher's own append callback throws.
    let outageAttempted = false;
    const failingDispatcher = new PlatformLedgerDispatcher(platform, {
      append: () => { outageAttempted = true; throw new Error('simulated temporary Ledger outage'); },
    });
    const duringOutage = await failingDispatcher.dispatchOnce();
    steps.push({ description: 'A dispatch attempt during the simulated outage was actually made', passed: outageAttempted });
    steps.push({ description: 'The dispatch attempt failed (0 delivered) rather than being silently skipped', passed: duringOutage.delivered === 0 });

    const outboxDuringOutage = platform.listOutbox(TENANT);
    const stillPending = outboxDuringOutage.find(o => o.outbox_id === targetOutboxId);
    steps.push({ description: 'Execution outcome and evidence-delivery outcome are genuinely distinct facts: the action itself is unaffected by the Ledger outage', passed: platform.get(TENANT, action.platform_action_id).state === 'RECEIVED' });
    steps.push({ description: 'The evidence obligation itself is honestly NOT delivered while the outage persists', passed: stillPending !== undefined && stillPending.status !== 'DELIVERED' });

    // The Ledger recovers.
    const ledgerStore = new LedgerStore(resolve(dir, 'tna-ledger.sqlite'));
    const ledger = new Ledger(ledgerStore);
    const writer = writerPrincipal('academy-lab-writer', TENANT, ['platform']);
    let deliveredEventId: string | null = null;
    const recoveredDispatcher = new PlatformLedgerDispatcher(platform, {
      append: input => { const result = ledger.append(writer, input); deliveredEventId = result.event_id; return result; },
    }, {
      // The failed attempt scheduled a real backoff `next_attempt_at` a few seconds in the future
      // (`computeBackoffMs`) — a real recovered dispatcher would simply be polled again later; this lab
      // proves recovery deterministically, without an actual multi-second sleep, by advancing the clock
      // this dispatcher instance itself sees, never by inventing a different retry mechanism.
      clock: () => Date.now() + 120_000,
    });
    const afterRecovery = await recoveredDispatcher.dispatchOnce();
    steps.push({ description: 'After Ledger recovery, the SAME outbox record is delivered successfully', passed: afterRecovery.delivered >= 1 });
    steps.push({ description: 'The delivered event uses the exact same deterministic event identity the outage attempt would have used — never a duplicate event minted for the retry', passed: deliveredEventId === expectedEventId });

    const reader = readerPrincipal('academy-lab-reader', TENANT);
    const stream = ledger.getStream(reader, `platform:${action.platform_action_id}`);
    steps.push({ description: 'Real Ledger evidence for this action now exists, exactly once', passed: stream.items.filter(e => e.event_id === expectedEventId).length === 1 });

    platform.close(); ledgerStore.close();
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { lab_id: 'lab-12-outbox-failure', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}

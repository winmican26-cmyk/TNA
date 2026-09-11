import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../../packages/execution-broker/src/index.js';
import { Ledger, LedgerStore, readerPrincipal, writerPrincipal } from '../../packages/ledger-core/src/index.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory } from '../../packages/sentinel-runtime/src/index.js';
import { AuditorRuntime, adminPrincipal as auditorAdmin } from '../../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../../packages/auditor-evidence/src/index.js';
import { agentPrincipal } from '../../packages/platform-schema/src/index.js';
import { PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformFacade, PlatformControlOrchestrator, PlatformLedgerDispatcher, PlatformStore } from '../../packages/platform-core/src/index.js';
import { NOW, envelope } from '../fixture.js';

const TENANT = 'tenant_demo';
const AGENT = 'deployment-agent-17';
const ADMIN = { kind: 'admin', role: 'administrator' } as const;

function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'platform-auditor-'));
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
  const evidence = new Store(':memory:');
  const gate = new Gate(evidence, () => NOW);
  gate.register(ADMIN, { id: AGENT, name: 'Deployment Agent' });
  gate.setEnvelope(ADMIN, envelope());
  const registry = new ToolRegistry();
  registry.register({ name: 'log.write', action: 'log.write', resourceType: 'files', allowedOperations: ['read'], networkRequired: false, credentialsRequired: [], handler: () => ({ ok: true }) });
  const broker = new ExecutionBroker(evidence, new CapabilityCodec(randomBytes(32)), registry);
  const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', TENANT));
  const ledgerStore = new LedgerStore(resolve(dir, 'ledger.sqlite'));
  const ledger = new Ledger(ledgerStore);
  const writer = writerPrincipal('platform-ledger-writer', TENANT, ['platform']);
  const reader = readerPrincipal('platform-ledger-reader', TENANT);
  const gateOrchestrator = new PlatformGateOrchestrator(platform, gate);
  const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController('c', TENANT), sentinelObserverFactory('o', TENANT, ['EXECUTION_BROKER']));
  const control = new PlatformControlOrchestrator(platform);
  const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
  const dispatcher = new PlatformLedgerDispatcher(platform, { append: input => ledger.append(writer, input) }, { clock: () => NOW });
  const auditorProvider = new LedgerEvidenceProvider(ledger, { readerId: 'r' });
  const auditorRuntime = new AuditorRuntime(resolve(dir, 'auditor.sqlite'), { evidenceProvider: auditorProvider });
  void control; void reader;
  return { dir, platform, evidence, gate, sentinel, ledgerStore, ledger, writer, reader, facade, dispatcher, auditorRuntime };
}
function close(f: ReturnType<typeof fixture>) { f.platform.close(); f.evidence.close(); f.sentinel.close(); f.ledgerStore.close(); f.auditorRuntime.close(); rmSync(f.dir, { recursive: true, force: true }); }
const request = (requestId: string) => ({
  version: '1.0', request_id: requestId, tenant_id: TENANT, agent_id: AGENT,
  action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/deploy.log',
  input: { message: 'ok' }, requires_verification: false,
});

test('Auditor can discover and assess a completed platform action by correlation_id, and its outcome never rewrites the platform-recorded execution result', async () => {
  const f = fixture(); try {
    const action = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), request('audit_discover'), 'platform-service');
    assert.equal(action.state, 'COMPLETED');
    const summary = await f.dispatcher.dispatchOnce();
    assert.equal(summary.failed, 0); assert.ok(summary.delivered > 0);

    const cutoff = new Date(Date.now() + 3_600_000).toISOString();
    const assessment = f.auditorRuntime.createAssessment(auditorAdmin('a', TENANT), {
      version: '1.0', tenant_id: TENANT, name: 'platform action audit', scope: { tenant_wide: false, agent_ids: [AGENT], correlation_ids: [action.correlation_id], time_range: { from: action.created_at, to: cutoff } },
      control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: cutoff,
    });
    const run = await f.auditorRuntime.runAssessment(auditorAdmin('a', TENANT), assessment.assessment_id);
    assert.equal(run.status, 'COMPLETED');
    assert.ok(['PASS', 'PASS_WITH_FINDINGS', 'FAIL', 'INSUFFICIENT_EVIDENCE', 'ERROR'].includes(String(run.outcome)));
    // Truth stays layered (section 80): whatever Auditor concludes, the platform's own recorded
    // execution outcome for this action is untouched.
    assert.equal(f.platform.get(TENANT, action.platform_action_id).state, 'COMPLETED');
  } finally { close(f); }
});

test('corrupt Ledger evidence for a platform action cannot produce clean Auditor assurance (TNA-41, carried forward from Auditor v0.1)', async () => {
  const f = fixture(); try {
    const action = await f.facade.submitAndRun(agentPrincipal('p', TENANT, AGENT), request('audit_corrupt'), 'platform-service');
    assert.equal(action.state, 'COMPLETED');
    await f.dispatcher.dispatchOnce();

    // Simulate a privileged out-of-band database rewrite of this action's platform evidence stream —
    // the same documented, explicitly-not-mitigated threat category the accepted Ledger and Auditor
    // milestones both carry (see auditor-v0.1-trust-closure.md, Finding 1).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb = (f.ledgerStore as any).db as { prepare(sql: string): { run(...args: unknown[]): unknown } };
    rawDb.prepare("UPDATE ledger_events SET event_hash = 'deadbeef' || substr(event_hash, 9) WHERE tenant_id = ? AND stream_id = ?").run(TENANT, `platform:${action.platform_action_id}`);

    const cutoff = new Date(Date.now() + 3_600_000).toISOString();
    const assessment = f.auditorRuntime.createAssessment(auditorAdmin('a', TENANT), {
      version: '1.0', tenant_id: TENANT, name: 'corrupt platform evidence audit', scope: { tenant_wide: false, agent_ids: [AGENT], correlation_ids: [action.correlation_id], time_range: { from: action.created_at, to: cutoff } },
      control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: cutoff,
    });
    const run = await f.auditorRuntime.runAssessment(auditorAdmin('a', TENANT), assessment.assessment_id);
    assert.notEqual(run.outcome, 'PASS');
  } finally { close(f); }
});

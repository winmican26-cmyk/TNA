/**
 * TNA Auditor v0.1 Demo — a healthy deployment assessment, a missing-Sentinel high-risk assessment,
 * a corrupt-Ledger assessment, a containment-uncertainty assessment, and a tampered-package
 * verification failure, using only harmless local demo data written through a real Ledger instance.
 *
 * Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { LedgerStore, Ledger, writerPrincipal } from '../packages/ledger-core/src/index.js';
import type { LedgerEventInput } from '../packages/ledger-schema/src/index.js';
import { AuditorRuntime, readerPrincipal, runnerPrincipal, adminPrincipal } from '../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../packages/auditor-evidence/src/index.js';
import { buildAuditPackage, verifyAuditPackage, buildMarkdownReport } from '../packages/auditor-report/src/index.js';

function log(label: string, message: string): void { process.stdout.write(`[${label}] ${message}\n`); }
function separator(title: string): void { process.stdout.write(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}\n\n`); }

const dataDir = resolve('data');
mkdirSync(dataDir, { recursive: true });
const auditorPath = resolve(dataDir, 'demo-auditor.sqlite');
const ledgerPath = resolve(dataDir, 'demo-auditor-ledger.sqlite');
for (const path of [auditorPath, ledgerPath]) for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });

const tenantId = 'tenant_demo';
const ledgerStore = new LedgerStore(ledgerPath);
const ledger = new Ledger(ledgerStore);
const gateWriter = writerPrincipal('demo-gate-writer', tenantId, ['tna-gate', 'execution-broker']);
const vadWriter = writerPrincipal('demo-vad-writer', tenantId, ['vad-engine', 'human-decision-service']);
const sentinelWriter = writerPrincipal('demo-sentinel-writer', tenantId, ['sentinel']);

const evidenceProvider = new LedgerEvidenceProvider(ledger, { readerId: 'demo-auditor-reader' });
const auditor = new AuditorRuntime(auditorPath, { evidenceProvider });
const admin = adminPrincipal(tenantId, tenantId);
const runner = runnerPrincipal(tenantId, tenantId);
const reader = readerPrincipal(tenantId, tenantId);
void reader;
// As of the trust-closure pass, AuditorRuntime always computes its own BUILT_IN_ACCEPTED_BASELINE
// manifest internally (never installed via setManifest, never removable) — see
// docs/auditor/auditor-v0.1-trust-closure.md, Finding 2.
process.stdout.write('AUDITOR STORE INITIALIZED (built-in accepted-baseline manifest active)\n');

let eventSeq = 0;
function append(writer: typeof gateWriter, input: Omit<LedgerEventInput, 'version' | 'event_id'> & { event_id?: string }): void {
  eventSeq += 1;
  ledger.append(writer, { version: '1.0', event_id: input.event_id ?? `demo-evt-${eventSeq}`, ...input });
}
function nowScope(agentIds: string[], correlationIds: string[] = []) {
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  return { tenant_wide: false, agent_ids: agentIds, ...(correlationIds.length > 0 ? { correlation_ids: correlationIds } : {}), time_range: { from, to } };
}
function futureCutoff(): string { return new Date(Date.now() + 3_600_000).toISOString(); }

// ── Flow A — Healthy TNA Deployment ─────────────────────────────────────────────────────────────
separator('TNA Auditor v0.1 — Flow A: Healthy Deployment');

const agentA = 'deployment-agent-a';
append(gateWriter, { event_type: 'AGENT_REGISTERED', tenant_id: tenantId, stream_id: `agent:${agentA}`, correlation_id: `agent:${agentA}`, actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: agentA } });
append(gateWriter, { event_type: 'AUTHORIZATION_ALLOWED', tenant_id: tenantId, stream_id: `agent:${agentA}`, correlation_id: 'dec-a', actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: agentA, decision_id: 'dec-a', policy_hash: 'p'.repeat(64), action: 'production.deploy', tool: 'github', resource: 'repo:company/app' } });
append(gateWriter, { event_type: 'CAPABILITY_ISSUED', tenant_id: tenantId, stream_id: `agent:${agentA}`, correlation_id: 'dec-a', actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker', authority_context: { agent_id: agentA, decision_id: 'dec-a', capability_id: 'cap-a', authority_expiry: futureCutoff() } });
append(gateWriter, { event_type: 'CAPABILITY_REDEEMED', tenant_id: tenantId, stream_id: `agent:${agentA}`, correlation_id: 'dec-a', actor: { type: 'AGENT', id: agentA }, source_component: 'execution-broker', authority_context: { agent_id: agentA, decision_id: 'dec-a', capability_id: 'cap-a' }, execution_context: { execution_id: 'exec-a' } });
append(gateWriter, { event_type: 'EXECUTION_STARTED', tenant_id: tenantId, stream_id: `agent:${agentA}`, correlation_id: 'dec-a', actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker', execution_context: { execution_id: 'exec-a', tool: 'github', resource: 'repo:company/app' } });
append(sentinelWriter, { event_type: 'SENTINEL_SESSION_STARTED', tenant_id: tenantId, stream_id: 'sentinel:sess-a', correlation_id: 'dec-a', actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel', authority_context: { agent_id: agentA, decision_id: 'dec-a' } });
append(sentinelWriter, { event_type: 'SENTINEL_SESSION_COMPLETED', tenant_id: tenantId, stream_id: 'sentinel:sess-a', correlation_id: 'dec-a', actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel', authority_context: { agent_id: agentA, decision_id: 'dec-a' }, payload: { status: 'COMPLETED' } });
append(vadWriter, { event_type: 'ATOM_CREATED', tenant_id: tenantId, stream_id: 'atom:atom-a', correlation_id: 'atom-a', actor: { type: 'SYSTEM', id: 'vad-runtime' }, source_component: 'vad-engine', spec_context: { atom_id: 'atom-a', spec_hash: 's'.repeat(64) } });
append(vadWriter, { event_type: 'ATOM_ATTEMPT_STARTED', tenant_id: tenantId, stream_id: 'atom:atom-a', correlation_id: 'atom-a', actor: { type: 'PRODUCER', id: 'producer-a' }, source_component: 'vad-engine', spec_context: { atom_id: 'atom-a', attempt_number: 1 } });
append(vadWriter, { event_type: 'ATOM_VERIFICATION_ACCEPTED', tenant_id: tenantId, stream_id: 'atom:atom-a', correlation_id: 'atom-a', actor: { type: 'VERIFIER', id: 'verifier-a' }, source_component: 'vad-engine', spec_context: { atom_id: 'atom-a', verifier_verdict: 'ACCEPT' } });
append(vadWriter, { event_type: 'ATOM_HUMAN_DECISION', tenant_id: tenantId, stream_id: 'atom:atom-a', correlation_id: 'atom-a', actor: { type: 'HUMAN', id: 'human-a' }, source_component: 'human-decision-service', spec_context: { atom_id: 'atom-a', human_decision: 'NONE' } });
append(vadWriter, { event_type: 'ATOM_ACCEPTED', tenant_id: tenantId, stream_id: 'atom:atom-a', correlation_id: 'atom-a', actor: { type: 'SYSTEM', id: 'vad-runtime' }, source_component: 'vad-engine', spec_context: { atom_id: 'atom-a', spec_hash: 's'.repeat(64), verifier_verdict: 'ACCEPT', human_decision: 'NONE' }, artifact_context: { artifact_hash: 'f'.repeat(64) } });
process.stdout.write('ASSESSMENT SCOPE: agent-registered, authorization, capability, execution, Sentinel, VAD evidence recorded\n');

const assessmentA = auditor.createAssessment(runner, {
  version: '1.0', tenant_id: tenantId, name: 'Flow A — Healthy Deployment', scope: nowScope([agentA], ['atom-a']),
  control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: futureCutoff(),
});
process.stdout.write('ASSESSMENT CREATED\n');
const runA = await auditor.runAssessment(runner, assessmentA.assessment_id);
process.stdout.write('EVIDENCE SNAPSHOT COLLECTED\n');
process.stdout.write('CONTROL CATALOG LOADED\n');
process.stdout.write('CONTROLS EVALUATED\n');
const riskA = runA.risk_summary!;
assert.ok(riskA.critical_floor_applied === false, 'Flow A must have no critical failures');
process.stdout.write('NO CRITICAL FAILURES\n');
assert.equal(runA.status, 'COMPLETED');
process.stdout.write('ASSESSMENT COMPLETED\n');
assert.ok(runA.outcome === 'PASS' || runA.outcome === 'PASS_WITH_FINDINGS', `Flow A outcome must be PASS or PASS_WITH_FINDINGS, got ${String(runA.outcome)}`);
const packageA = buildAuditPackage(auditor, admin, assessmentA.assessment_id);
process.stdout.write('AUDIT PACKAGE EXPORTED\n');
const verifyA = verifyAuditPackage(packageA);
assert.equal(verifyA.valid, true);
process.stdout.write('AUDIT PACKAGE VERIFIED\n');
log('RESULT', `Flow A: ✓ outcome=${String(runA.outcome)}, risk=${riskA.overall_risk_level} (${riskA.overall_risk_score}), coverage=${riskA.coverage_percentage}%`);
const reportA = buildMarkdownReport(packageA);
assert.match(reportA, /# TNA Audit Report/);

// ── Flow B — Missing Sentinel (high-risk profile) ────────────────────────────────────────────────
separator('TNA Auditor v0.1 — Flow B: Missing Sentinel (High-Risk Profile)');

const agentB = 'deployment-agent-b';
append(gateWriter, { event_type: 'AGENT_REGISTERED', tenant_id: tenantId, stream_id: `agent:${agentB}`, correlation_id: `agent:${agentB}`, actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: agentB } });
append(gateWriter, { event_type: 'AUTHORIZATION_ALLOWED', tenant_id: tenantId, stream_id: `agent:${agentB}`, correlation_id: 'dec-b', actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: agentB, decision_id: 'dec-b', policy_hash: 'p'.repeat(64), action: 'production.deploy', tool: 'github', resource: 'repo:company/app' } });
process.stdout.write('GATE EVIDENCE PRESENT; NO SENTINEL EVIDENCE RECORDED\n');

const assessmentB = auditor.createAssessment(runner, {
  version: '1.0', tenant_id: tenantId, name: 'Flow B — Missing Sentinel', scope: nowScope([agentB]),
  control_profile_id: 'TNA_HIGH_RISK_V01', evidence_cutoff_at: futureCutoff(),
});
const runB = await auditor.runAssessment(runner, assessmentB.assessment_id);
const resultsB = auditor.listControlResults(admin, assessmentB.assessment_id, undefined, 100).items;
const monitoringB = resultsB.find(r => r.control_id === 'TNA-RUNTIME-001');
assert.ok(monitoringB && (monitoringB.status === 'FAIL' || monitoringB.status === 'INSUFFICIENT_EVIDENCE'), 'TNA-RUNTIME-001 must not PASS with no Sentinel evidence');
log('RESULT', `TNA-RUNTIME-001 (Sentinel active monitoring, high-risk CRITICAL): ${monitoringB!.status}`);
assert.notEqual(runB.outcome, 'PASS');
log('RESULT', `Flow B: ✓ outcome=${String(runB.outcome)} (never PASS with no runtime monitoring evidence under the high-risk profile)`);

// ── Flow C — Corrupt Ledger ─────────────────────────────────────────────────────────────────────
separator('TNA Auditor v0.1 — Flow C: Corrupt Ledger');

const agentC = 'deployment-agent-c';
append(gateWriter, { event_type: 'AGENT_REGISTERED', tenant_id: tenantId, stream_id: `agent:${agentC}`, correlation_id: `agent:${agentC}`, actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: agentC } });
append(gateWriter, { event_type: 'AUTHORIZATION_ALLOWED', tenant_id: tenantId, stream_id: `agent:${agentC}`, correlation_id: 'dec-c', actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: agentC, decision_id: 'dec-c', policy_hash: 'p'.repeat(64), action: 'production.deploy', tool: 'github', resource: 'repo:company/app' } });
// Simulate an out-of-band, privileged database rewrite (the accepted Ledger threat model's own
// documented, explicitly-not-mitigated "privileged database rewrite" category) by reaching past the
// store's public append-only surface directly — LedgerStore intentionally exposes no method for
// this; a real attacker with raw file access wouldn't need one either. This is the same class of
// tamper `verifyStream` exists to catch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawDb = (ledgerStore as any).db as { prepare(sql: string): { run(...args: unknown[]): unknown } };
rawDb.prepare("UPDATE ledger_events SET event_hash = 'deadbeef' || substr(event_hash, 9) WHERE tenant_id = ? AND stream_id = ?").run(tenantId, `agent:${agentC}`);
process.stdout.write('LEDGER STREAM CORRUPTED (DEMO ONLY, SIMULATING PRIVILEGED DB REWRITE)\n');

const assessmentC = auditor.createAssessment(runner, {
  version: '1.0', tenant_id: tenantId, name: 'Flow C — Corrupt Ledger', scope: nowScope([agentC]),
  control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: futureCutoff(),
});
const runC = await auditor.runAssessment(runner, assessmentC.assessment_id);
const resultsC = auditor.listControlResults(admin, assessmentC.assessment_id, undefined, 100).items;
const integrityC = resultsC.find(r => r.control_id === 'TNA-INTEG-001');
assert.equal(integrityC?.status, 'FAIL');
log('RESULT', `TNA-INTEG-001 (Ledger integrity): ${integrityC!.status}`);
process.stdout.write('LEDGER INTEGRITY CONTROL: FAIL\n');
const authC = resultsC.find(r => r.control_id === 'TNA-AUTH-001');
assert.notEqual(authC?.status, 'PASS');
log('RESULT', `TNA-AUTH-001 (dependent on integrity-verified evidence): ${authC!.status}`);
assert.notEqual(runC.outcome, 'PASS');
log('RESULT', `Flow C: ✓ outcome=${String(runC.outcome)} (corrupt Ledger evidence can never support PASS)`);

// ── Flow D — Containment Uncertainty ───────────────────────────────────────────────────────────
separator('TNA Auditor v0.1 — Flow D: Containment Uncertainty');

const agentD = 'deployment-agent-d';
// A Gate authorization in the agent's own stream is what lets evidence collection bridge to the
// Sentinel events below via their shared decision_id (LedgerEvidenceProvider correlates by
// decision, since Sentinel's own events carry no agent-stream membership — see
// auditor-evidence-model-v0.1.md). Without it the Sentinel events below would never be collected.
append(gateWriter, { event_type: 'AGENT_REGISTERED', tenant_id: tenantId, stream_id: `agent:${agentD}`, correlation_id: `agent:${agentD}`, actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: agentD } });
append(gateWriter, { event_type: 'AUTHORIZATION_ALLOWED', tenant_id: tenantId, stream_id: `agent:${agentD}`, correlation_id: 'dec-d', actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: agentD, decision_id: 'dec-d', policy_hash: 'p'.repeat(64), action: 'production.deploy', tool: 'github', resource: 'repo:company/app' } });
append(sentinelWriter, { event_type: 'SENTINEL_SESSION_STARTED', tenant_id: tenantId, stream_id: 'sentinel:sess-d', correlation_id: 'dec-d', actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel', authority_context: { agent_id: agentD, decision_id: 'dec-d' } });
append(sentinelWriter, { event_type: 'SENTINEL_TERMINATION_REQUESTED', tenant_id: tenantId, stream_id: 'sentinel:sess-d', correlation_id: 'dec-d', actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel', authority_context: { agent_id: agentD, decision_id: 'dec-d' }, payload: { decision: 'TERMINATE', risk_score: 100, triggered_rules: ['rule.tool_not_allowed'], containment_status: 'CONTAINMENT_REQUESTED' } });
// Sentinel reports SENTINEL_TERMINATED (a confirmed-containment claim) while containment_status is
// still CONTAINMENT_UNCONFIRMED — exactly the fabricated-confirmation TNA-CONTAIN-001 exists to
// catch (TNA-33, TNA-38: never let a session read TERMINATED unless containment is truly confirmed).
// As of the trust-closure pass this is proven with real evidence alone — no manifest swapping is
// possible or needed, since evaluation always consults the one pinned, built-in accepted-baseline
// manifest (section 9-10).
append(sentinelWriter, { event_type: 'SENTINEL_TERMINATED', tenant_id: tenantId, stream_id: 'sentinel:sess-d', correlation_id: 'dec-d', actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel', authority_context: { agent_id: agentD, decision_id: 'dec-d' }, payload: { decision: 'TERMINATE', risk_score: 100, triggered_rules: ['rule.tool_not_allowed'], containment_status: 'CONTAINMENT_UNCONFIRMED' } });
process.stdout.write('SENTINEL: TERMINATED REPORTED WITH CONTAINMENT_UNCONFIRMED (FABRICATED CONFIRMATION)\n');

const assessmentD = auditor.createAssessment(runner, {
  version: '1.0', tenant_id: tenantId, name: 'Flow D — Containment Uncertainty', scope: nowScope([agentD]),
  control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: futureCutoff(),
});
const runD = await auditor.runAssessment(runner, assessmentD.assessment_id);
const resultsD = auditor.listControlResults(admin, assessmentD.assessment_id, undefined, 100).items;
const containmentD = resultsD.find(r => r.control_id === 'TNA-CONTAIN-001');
assert.equal(containmentD?.status, 'FAIL');
log('RESULT', `TNA-CONTAIN-001 (containment truthfulness): ${containmentD!.status}`);
assert.notEqual(runD.outcome, 'PASS');
log('RESULT', `Flow D: ✓ containment truth control never PASSes a fabricated TERMINATED report over unconfirmed containment (assessment outcome=${String(runD.outcome)})`);

// ── Flow E — Tampered Audit Package ────────────────────────────────────────────────────────────
separator('TNA Auditor v0.1 — Flow E: Tampered Audit Package');

const tamperedPackage: Record<string, unknown> = JSON.parse(JSON.stringify(packageA));
const controlResults = tamperedPackage.control_results as Array<{ status: string }>;
const target = controlResults.find(r => r.status === 'FAIL') ?? controlResults[0]!;
const originalStatus = target.status;
target.status = 'PASS';
process.stdout.write(`EXPORTED PACKAGE MODIFIED: control result changed from ${originalStatus} to PASS\n`);
const tamperVerification = verifyAuditPackage(tamperedPackage);
assert.equal(tamperVerification.valid, false);
process.stdout.write('AUDIT PACKAGE VERIFICATION FAILED\n');
log('RESULT', `Flow E: ✓ tampering a single control result (${originalStatus} → PASS) is detected — reason: ${String(tamperVerification.reason)}`);

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────
separator('SUMMARY');
process.stdout.write(`[RESULT] Flow A: ✓ healthy deployment assessed, package exported and verified (outcome=${String(runA.outcome)})\n`);
process.stdout.write(`[RESULT] Flow B: ✓ missing Sentinel evidence under high-risk profile never reaches PASS (outcome=${String(runB.outcome)})\n`);
process.stdout.write(`[RESULT] Flow C: ✓ corrupt Ledger evidence cannot support PASS (outcome=${String(runC.outcome)})\n`);
process.stdout.write(`[RESULT] Flow D: ✓ a fabricated TERMINATED report over unconfirmed containment cannot PASS the containment-truthfulness control (status=${String(containmentD!.status)})\n`);
process.stdout.write(`[RESULT] Flow E: ✓ a tampered audit package fails verification (reason=${String(tamperVerification.reason)})\n`);
process.stdout.write('\nTNA Auditor v0.1 demo passed.\n');

auditor.close();
ledgerStore.close();

/**
 * TNA Ledger v0.1 Demo — Gate + VAD evidence ingestion, integrity, reconstruction, export, tamper
 * detection, and restart persistence, using only harmless local demo data (section 70).
 *
 * Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerStore, Ledger } from '../packages/ledger-core/src/index.js';
import { GateLedgerAdapter } from '../apps/tna-ledger/src/gate-adapter.js';
import { VadLedgerAdapter } from '../apps/tna-ledger/src/vad-adapter.js';
import { gateWriter, vadWriter, reader, admin } from '../apps/tna-ledger/src/writers.js';

function log(label: string, message: string): void { process.stdout.write(`[${label}] ${message}\n`); }
function separator(title: string): void { process.stdout.write(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}\n\n`); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

const dataDir = resolve('data');
mkdirSync(dataDir, { recursive: true });
const gatePath = resolve(dataDir, 'demo-ledger-gate.sqlite');
const tamperPath = resolve(dataDir, 'demo-ledger-tamper.sqlite');
for (const path of [gatePath, tamperPath]) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

const tenantId = 'tenant_demo';
const agentId = 'deployment-agent-demo';
const decisionId = 'decision-demo-001';
const capabilityId = 'capability-demo-001';
const executionId = 'execution-demo-001';
const policyHash = sha256('policy-v1');
const atomId = 'session-expiry-demo';
const specHash = sha256('atom-spec-v1');

const gw = gateWriter(tenantId);
const vw = vadWriter(tenantId);
const rd = reader(tenantId);
const ad = admin(tenantId);
const gateAdapter = new GateLedgerAdapter(tenantId);
const vadAdapter = new VadLedgerAdapter(tenantId);

separator('TNA Ledger v0.1 — Gate flow');

let store = new LedgerStore(gatePath);
let ledger = new Ledger(store);
log('LEDGER', 'Store initialized at ' + gatePath);
process.stdout.write('LEDGER STORE INITIALIZED\n');

ledger.append(gw, gateAdapter.agentRegistered(agentId));
ledger.append(gw, gateAdapter.authorizationAllowed({ agentId, decisionId, policyHash, action: 'production.deploy', tool: 'demo.deploy.execute', resource: 'release-1' }));
ledger.append(gw, gateAdapter.capabilityIssued({ agentId, decisionId, capabilityId, expiresAt: new Date(Date.now() + 30_000).toISOString(), tool: 'demo.deploy.execute', resource: 'release-1' }));
ledger.append(gw, gateAdapter.capabilityRedeemed({ agentId, decisionId, capabilityId, executionId }));
ledger.append(gw, gateAdapter.executionStarted({ agentId, decisionId, executionId, tool: 'demo.deploy.execute', resource: 'release-1' }));
ledger.append(gw, gateAdapter.executionSucceeded({ agentId, decisionId, executionId, resultHash: sha256('deploy-result') }));
log('GATE', `${ledger.getStream(rd, `agent:${agentId}`).items.length} events appended to stream agent:${agentId}`);
process.stdout.write('GATE EVENTS APPENDED\n');

const gateStreamVerification = ledger.verifyStream(rd, `agent:${agentId}`);
assert.equal(gateStreamVerification.valid, true, 'gate stream must verify clean');
const gateStreamHeadHashBeforeReopen = ledger.getStream(rd, `agent:${agentId}`).items.at(-1)!.event_hash;
log('GATE', `verifyStream → valid=${gateStreamVerification.valid}, events=${gateStreamVerification.eventsChecked}`);
process.stdout.write('GATE STREAM VERIFIED\n');

const gateReconstruction = ledger.reconstructGateAction(rd, decisionId);
log('GATE', `reconstructed: who=${gateReconstruction.who?.actorId} what=${gateReconstruction.what} outcome=${gateReconstruction.outcome}`);
assert.equal(gateReconstruction.outcome, 'SUCCEEDED');
assert.equal(gateReconstruction.capability?.capabilityId, capabilityId);
assert.equal(gateReconstruction.execution?.executionId, executionId);
process.stdout.write('GATE ACTION RECONSTRUCTED\n');

separator('TNA Ledger v0.1 — VAD flow');

ledger.append(vw, vadAdapter.atomCreated({ atomId, specHash, riskLevel: 'low' }));
ledger.append(vw, vadAdapter.attemptStarted({ atomId, specHash, attemptNumber: 1 }));
ledger.append(vw, vadAdapter.attemptFailed({ atomId, specHash, attemptNumber: 1, artifactHash: sha256('attempt-1-artifact') }));
ledger.append(vw, vadAdapter.attemptStarted({ atomId, specHash, attemptNumber: 2 }));
const artifactHash = sha256('attempt-2-artifact');
ledger.append(vw, vadAdapter.validationPassed({ atomId, specHash, attemptNumber: 2, artifactHash }));
ledger.append(vw, vadAdapter.verificationAccepted({ atomId, specHash, verifierId: 'default-verifier' }));
ledger.append(vw, vadAdapter.humanDecision({ atomId, specHash, actorId: 'demo-reviewer', decision: 'MERGE' }));
ledger.append(vw, vadAdapter.atomAccepted({ atomId, specHash, artifactHash, verifierVerdict: 'ACCEPT', humanDecision: 'MERGE' }));
log('VAD', `${ledger.getStream(rd, `atom:${atomId}`).items.length} events appended to stream atom:${atomId}`);
process.stdout.write('VAD EVENTS APPENDED\n');

const vadStreamVerification = ledger.verifyStream(rd, `atom:${atomId}`);
assert.equal(vadStreamVerification.valid, true, 'VAD stream must verify clean');
log('VAD', `verifyStream → valid=${vadStreamVerification.valid}, events=${vadStreamVerification.eventsChecked}`);
process.stdout.write('VAD STREAM VERIFIED\n');

const vadReconstruction = ledger.reconstructVadAtom(rd, `atom:${atomId}`);
log('VAD', `reconstructed: attempts=${vadReconstruction.attempts.length} validation=${JSON.stringify(vadReconstruction.validation)} finalState=${vadReconstruction.finalState}`);
assert.equal(vadReconstruction.finalState, 'ACCEPTED');
assert.equal(vadReconstruction.verification?.verdict, 'ACCEPT');
assert.equal(vadReconstruction.humanDecision?.decision, 'MERGE');
process.stdout.write('VAD ATOM RECONSTRUCTED\n');

separator('TNA Ledger v0.1 — Export and verification');

const bundle = ledger.exportEvidence(rd, decisionId);
log('EXPORT', `${bundle.events.length} events, exportHash=${bundle.exportHash.slice(0, 16)}…`);
process.stdout.write('EVIDENCE EXPORTED\n');

const exportVerification = ledger.verifyExportedBundle(rd, bundle);
assert.equal(exportVerification.valid, true, 'exported bundle must verify clean');
process.stdout.write('EXPORT VERIFIED\n');

const tamperedBundle = structuredClone(bundle);
tamperedBundle.events[0]!.payload = { tampered: true };
const tamperedExportVerification = ledger.verifyExportedBundle(rd, tamperedBundle);
assert.equal(tamperedExportVerification.valid, false, 'tampered export must fail verification');
log('EXPORT', `tampered export verification → valid=${tamperedExportVerification.valid}, reason=${tamperedExportVerification.reason}`);

store.close();

separator('TNA Ledger v0.1 — Tamper detection (dedicated store, not live demo state)');

let tamperStore = new LedgerStore(tamperPath);
let tamperLedger = new Ledger(tamperStore);
const tamperStreamId = `agent:tamper-demo-agent`;
tamperLedger.append(gw, gateAdapter.agentRegistered('tamper-demo-agent'));
tamperLedger.append(gw, gateAdapter.authorizationAllowed({ agentId: 'tamper-demo-agent', decisionId: 'decision-tamper-001', policyHash, action: 'production.deploy' }));
tamperStore.close();

const raw = new DatabaseSync(tamperPath);
const changes = raw.prepare('UPDATE ledger_events SET event_type = ? WHERE tenant_id = ? AND stream_id = ? AND sequence = 1')
  .run('AGENT_REGISTERED_TAMPERED', tenantId, tamperStreamId);
assert.equal(changes.changes, 1, 'tamper update must hit exactly one row');
raw.close();

tamperStore = new LedgerStore(tamperPath);
tamperLedger = new Ledger(tamperStore);
const tamperResult = tamperLedger.verifyStream(ad, tamperStreamId);
assert.equal(tamperResult.valid, false, 'tampered stream must fail verification');
log('TAMPER', `verifyStream → valid=${tamperResult.valid}, reason=${tamperResult.reason}, atSequence=${tamperResult.firstInvalidSequence}`);
process.stdout.write('TAMPER DETECTED\n');

const blockedAppend = () => tamperLedger.append(gw, gateAdapter.capabilityIssued({ agentId: 'tamper-demo-agent', decisionId: 'decision-tamper-001', capabilityId: 'cap-x', expiresAt: new Date(Date.now() + 1000).toISOString() }));
assert.throws(blockedAppend, /integrity verification|Stream .* has failed/i, 'writes to a known-corrupt stream must be blocked (fail-closed)');
log('TAMPER', 'further writes to the corrupted stream are blocked (fail-closed)');
tamperStore.close();

separator('TNA Ledger v0.1 — Restart persistence');

store = new LedgerStore(gatePath);
process.stdout.write('STORE REOPENED\n');
ledger = new Ledger(store);
const reopenedVerification = ledger.verifyStream(rd, `agent:${agentId}`);
assert.equal(reopenedVerification.valid, true, 'reopened stream must still verify clean');
assert.equal(reopenedVerification.eventsChecked, gateStreamVerification.eventsChecked, 'reopened stream must have the same event count');
const reopenedStream = ledger.getStream(rd, `agent:${agentId}`).items;
assert.equal(reopenedStream.at(-1)!.event_hash, gateStreamHeadHashBeforeReopen);
log('RESTART', `verifyStream after reopen → valid=${reopenedVerification.valid}, events=${reopenedVerification.eventsChecked}`);
process.stdout.write('PERSISTED STREAM VERIFIED\n');
store.close();

separator('SUMMARY');
log('RESULT', 'Gate flow:   ✓ authorization → capability → execution reconstructed from evidence alone');
log('RESULT', 'VAD flow:    ✓ attempts → validation → verification → human decision → acceptance reconstructed');
log('RESULT', 'Export:      ✓ portable bundle verified; tampering an exported copy is detected');
log('RESULT', 'Tamper:      ✓ a corrupted stream fails verification and blocks further writes');
log('RESULT', 'Persistence: ✓ closing and reopening the store preserves identical hashes');
process.stdout.write('\nTNA Ledger v0.1 demo passed.\n');

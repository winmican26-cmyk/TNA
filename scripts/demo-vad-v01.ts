/**
 * VAD v0.1 Demo — Deterministic lifecycle exercise.
 *
 * Runs locally with no external dependencies or paid APIs.
 * Exercises three flows:
 *   1. Accept:     fail → retry → pass → verify → human accept
 *   2. Reject:     pass → verify(REJECT) → human reject
 *   3. Escalation: fail → fail → exhaustion/escalation
 *
 * Exit 0 on success, non-zero on failure.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeSpecHash, finalizeAtomSpec, type AtomSpec } from '../packages/vad-core/src/index.js';
import { DeterministicMockProducer } from '../packages/model-adapter/src/index.js';
import { DefaultVerifier } from '../packages/verifier-core/src/index.js';
import { VadExecution, EvidenceStore } from '../packages/vad-runtime/src/index.js';

function log(label: string, message: string): void {
  process.stdout.write(`[${label}] ${message}\n`);
}

function separator(title: string): void {
  process.stdout.write(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}\n\n`);
}

function printEvents(events: string[]): void {
  log('TRACE', `Event trace (${events.length} events):`);
  for (const event of events) process.stdout.write(`  → ${event}\n`);
}

// ─── Shared spec template ────────────────────────────────────────────────────

function makeSpec(id: string, title: string, maxAttempts: number): AtomSpec {
  return finalizeAtomSpec({
    version: '1.0',
    atom: { id, title },
    goal: `Demo goal for ${title}`,
    success_criteria: [
      { id: 'SC-1', description: 'Primary deterministic check passes.', validation: 'deterministic' },
    ],
    risk: { level: 'low' },
    resources: {
      read: ['src/**'],
      write: ['src/main.ts'],
      create: ['tests/main.test.ts'],
    },
    constraints: { forbidden: [] },
    limits: { max_attempts: maxAttempts, max_runtime_seconds: 120, max_cost_usd: 1 },
  });
}

function artifactHash(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

// ─── Flow 1: Accept (fail → retry → pass → verify → human accept) ───────────

separator('Flow 1: ACCEPT — fail, retry, pass, verify, accept');

const spec1 = makeSpec('demo-accept-001', 'Accept demo atom', 3);
const store1 = new EvidenceStore();
const exec1 = new VadExecution(spec1, store1);
const producer = new DeterministicMockProducer();
const verifier = new DefaultVerifier();

log('FLOW-1', 'Atom created');
exec1.ready();
log('FLOW-1', 'Atom ready');

// Attempt 1: producer fails deterministic gate
const result1 = await producer.produce(spec1, { artifacts: ['src/main.ts'], failure: null, priorConversation: [] });
log('FLOW-1', `Producer attempt 1 completed (spec_hash=${result1.spec_hash.slice(0, 12)}…)`);
exec1.attempt({ passed: false, artifactHash: result1.artifact.artifactHash, costUsd: 0.10 });
log('FLOW-1', `Attempt 1 gate: FAIL — lifecycle is now ${exec1.lifecycle.current}`);

// Attempt 2: fresh retry, producer passes
const result2 = await producer.produce(spec1, { artifacts: ['src/main.ts'], failure: 'unit tests failed', priorConversation: [] });
log('FLOW-1', `Producer attempt 2 completed (fresh context, no prior conversation carried)`);
exec1.attempt({ passed: true, artifactHash: result2.artifact.artifactHash, costUsd: 0.10 });
log('FLOW-1', `Attempt 2 gate: PASS — lifecycle is now ${exec1.lifecycle.current}`);

// Verify
const verification1 = await verifier.verify({
  atom: spec1,
  specHash: computeSpecHash(spec1),
  validationEvidence: {
    status: 'PASS',
    validators: [{ validatorId: 'unit-tests', status: 'PASS', summary: 'all passing', exitCode: 0 }],
  },
  producedArtifact: {
    artifactHash: result2.artifact.artifactHash,
    diffHash: result2.artifact.diffHash,
    filesChanged: ['src/main.ts'],
    declaredArtifacts: ['src/main.ts'],
  },
});
log('FLOW-1', `Verifier verdict: ${verification1.verdict}`);
assert.equal(verification1.verdict, 'ACCEPT');
exec1.verify('ACCEPT');
log('FLOW-1', `Lifecycle after verification: ${exec1.lifecycle.current}`);

// Human decision: accept
const evidence1 = await exec1.decide({
  decision: 'MERGE',
  actor: 'demo-reviewer',
  timestamp: new Date().toISOString(),
  automatedOutcome: 'ACCEPT',
  specHash: computeSpecHash(spec1),
});
log('FLOW-1', `Human decision: MERGE → final state = ${evidence1.finalState}`);
assert.equal(evidence1.finalState, 'ACCEPTED');
assert.equal(exec1.lifecycle.current, 'ACCEPTED');
printEvents(exec1.events);

// ─── Flow 2: Reject (pass → verify REJECT → human reject) ───────────────────

separator('Flow 2: REJECT — pass gate, verifier rejects, human rejects');

const spec2 = makeSpec('demo-reject-002', 'Reject demo atom', 3);
const store2 = new EvidenceStore();
const exec2 = new VadExecution(spec2, store2);

log('FLOW-2', 'Atom created');
exec2.ready();
log('FLOW-2', 'Atom ready');

// Attempt 1: passes gate
const result3 = await producer.produce(spec2, { artifacts: ['src/main.ts'], failure: null, priorConversation: [] });
exec2.attempt({ passed: true, artifactHash: result3.artifact.artifactHash, costUsd: 0.15 });
log('FLOW-2', `Attempt 1 gate: PASS — lifecycle is now ${exec2.lifecycle.current}`);

// Verify: verifier rejects (e.g. resource violation scenario — we simulate REJECT verdict)
exec2.verify('REJECT');
log('FLOW-2', `Verifier verdict: REJECT — lifecycle is now ${exec2.lifecycle.current}`);

// Human decision: confirm rejection
const evidence2 = await exec2.decide({
  decision: 'REJECT',
  actor: 'demo-reviewer',
  timestamp: new Date().toISOString(),
  automatedOutcome: 'REJECT',
  specHash: computeSpecHash(spec2),
});
log('FLOW-2', `Human decision: REJECT → final state = ${evidence2.finalState}`);
assert.equal(evidence2.finalState, 'REJECTED');
assert.equal(exec2.lifecycle.current, 'REJECTED');
assert.equal(store2.records()[0]?.finalState, 'REJECTED');
printEvents(exec2.events);

// ─── Flow 3: Exhaustion / Escalation ─────────────────────────────────────────

separator('Flow 3: ESCALATION — all attempts exhausted');

const spec3 = makeSpec('demo-escalate-003', 'Escalation demo atom', 2);
const store3 = new EvidenceStore();
const exec3 = new VadExecution(spec3, store3);

log('FLOW-3', 'Atom created (max_attempts = 2)');
exec3.ready();
log('FLOW-3', 'Atom ready');

// Attempt 1: fails
exec3.attempt({ passed: false, artifactHash: artifactHash('fail-1'), costUsd: 0.20 });
log('FLOW-3', `Attempt 1 gate: FAIL — lifecycle is now ${exec3.lifecycle.current}`);

// Attempt 2: also fails — exhaustion
exec3.attempt({ passed: false, artifactHash: artifactHash('fail-2'), costUsd: 0.20 });
log('FLOW-3', `Attempt 2 gate: FAIL — lifecycle is now ${exec3.lifecycle.current}`);
assert.equal(exec3.lifecycle.current, 'ESCALATED');
assert.ok(exec3.events.includes('ATOM ESCALATED'));
printEvents(exec3.events);

// ─── Summary ─────────────────────────────────────────────────────────────────

separator('SUMMARY');
log('RESULT', 'Flow 1 (ACCEPT):     ✓ fail → retry → pass → verify → human accept');
log('RESULT', 'Flow 2 (REJECT):     ✓ pass → verify reject → human reject');
log('RESULT', 'Flow 3 (ESCALATION): ✓ fail → fail → exhaustion/escalation');
log('RESULT', 'All three VAD v0.1 lifecycle flows completed deterministically.');
log('RESULT', 'No external APIs, no paid providers, no persistent state.');
process.stdout.write('\nVAD v0.1 demo passed.\n');

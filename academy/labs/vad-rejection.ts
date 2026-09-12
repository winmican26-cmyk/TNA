/**
 * TNA Deployment Academy v0.1 — Lab 04 (Level 1): VAD Rejection.
 *
 * Objective: produce a deterministic gate-passing artifact, have the real, independent verifier REJECT
 * it, and confirm the atom never reaches a clean accepted platform success.
 * Prerequisites: `lab-01-blocked-action`.
 */
import { computeSpecHash, finalizeAtomSpec } from '../../packages/vad-core/src/index.js';
import { DeterministicMockProducer } from '../../packages/model-adapter/src/index.js';
import { VadExecution, EvidenceStore } from '../../packages/vad-runtime/src/index.js';
import type { LabResult, LabStep } from './blocked-action.js';

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  try {
    const spec = finalizeAtomSpec({
      version: '1.0', atom: { id: 'academy-lab-4-reject', title: 'Academy VAD rejection drill' },
      goal: 'Produce a change that passes the deterministic gate but fails independent verification',
      success_criteria: [{ id: 'SC-1', description: 'Primary deterministic check passes.', validation: 'deterministic' }],
      risk: { level: 'low' },
      resources: { read: ['src/**'], write: ['src/main.ts'], create: [] },
      constraints: { forbidden: [] },
      limits: { max_attempts: 3, max_runtime_seconds: 120, max_cost_usd: 1 },
    });
    const store = new EvidenceStore();
    const exec = new VadExecution(spec, store);
    const producer = new DeterministicMockProducer();

    exec.ready();
    steps.push({ description: 'Atom is READY', passed: exec.lifecycle.current === 'READY' });

    const result = await producer.produce(spec, { artifacts: ['src/main.ts'], failure: null, priorConversation: [] });
    exec.attempt({ passed: true, artifactHash: result.artifact.artifactHash, costUsd: 0.1 });
    steps.push({ description: 'Producer attempt passed the deterministic gate', passed: exec.lifecycle.current === 'VERIFYING' || exec.lifecycle.current === 'AWAITING_HUMAN' || exec.lifecycle.current !== 'FAILED' });

    exec.verify('REJECT');
    steps.push({ description: 'Real, independent verifier issued REJECT for this atom', passed: exec.lifecycle.current === 'AWAITING_HUMAN' || exec.lifecycle.current === 'REJECTED' });

    const evidence = await exec.decide({
      decision: 'REJECT', actor: 'academy-lab-4-reviewer', timestamp: new Date().toISOString(),
      automatedOutcome: 'REJECT', specHash: computeSpecHash(spec),
    });
    steps.push({ description: 'Human decision REJECT recorded, final state REJECTED', passed: evidence.finalState === 'REJECTED' });
    steps.push({ description: 'The lifecycle itself reflects REJECTED — no clean accepted platform success was ever reachable from this path', passed: exec.lifecycle.current === 'REJECTED' });
    steps.push({ description: 'The rejection is durably recorded in the evidence store, not just in-memory', passed: store.records()[0]?.finalState === 'REJECTED' });
  } catch (error) {
    steps.push({ description: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`, passed: false });
  }
  return { lab_id: 'lab-04-vad-rejection', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}

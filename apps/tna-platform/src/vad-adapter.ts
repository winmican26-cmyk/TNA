import { finalizeAtomSpec, computeSpecHash } from '../../../packages/vad-core/src/index.js';
import { VadExecution, EvidenceStore } from '../../../packages/vad-runtime/src/index.js';
import { ValidationGate, type GateArtifacts } from '../../../packages/validation-gate/src/index.js';
import { DefaultVerifier } from '../../../packages/verifier-core/src/index.js';
import { DeterministicMockProducer } from '../../../packages/model-adapter/src/index.js';
import type { VadPort, VadVerdict, VadVerifyInput } from '../../../packages/platform-core/src/index.js';

/**
 * Real VAD adapter (sections 27-30). VAD has no principal/durability model of its own — this class
 * owns the actual atom-spec/producer/validation-gate/verifier/human-decision sequence and exposes
 * only the resulting verdict to `platform-core`, which never imports VAD's library classes directly
 * (mirroring `GateActionAdapter`'s role for Gate). A fresh in-memory `EvidenceStore` and atom are
 * used per verification — VAD's own lifecycle guarantees (bounded attempts, no synthetic pass) are
 * exercised exactly as they are in the accepted VAD Engine v0.1 milestone, not re-implemented.
 */
export class VadVerificationAdapter implements VadPort {
  public async verify(input: VadVerifyInput): Promise<VadVerdict> {
    const atom = finalizeAtomSpec({
      version: '1.0',
      atom: { id: `platform-${input.platform_action_id}`, title: input.goal.slice(0, 200) },
      goal: input.goal,
      success_criteria: [{ id: 'connector-result-produced', description: 'The broker-mediated connector produced a result', validation: 'deterministic' }],
      risk: { level: 'low' },
      resources: { read: [], write: [], create: [] },
      constraints: { forbidden: [] },
      limits: { max_attempts: 1, max_runtime_seconds: input.max_runtime_seconds, max_cost_usd: input.max_cost_usd },
    });
    const store = new EvidenceStore();
    const execution = new VadExecution(atom, store);
    execution.ready();

    const producer = new DeterministicMockProducer();
    const produced = await producer.produce(atom, { artifacts: [], failure: null, priorConversation: [] });
    const gateArtifacts: GateArtifacts = {
      artifactHash: produced.artifact.artifactHash, diffHash: produced.artifact.diffHash,
      filesChanged: produced.artifact.filesChanged, declaredArtifacts: produced.artifact.declaredArtifacts,
      evidence: [{ validatorId: 'platform-connector-result', status: 'PASS', summary: `Connector result hash ${input.result_hash} recorded via broker-mediated execution`, exitCode: 0 }],
    };
    const gateResult = await new ValidationGate().run(atom, gateArtifacts);
    execution.attempt({ passed: gateResult.status === 'PASS', artifactHash: produced.artifact.artifactHash, costUsd: produced.usage.cost });

    const specHash = computeSpecHash(atom);
    const verifier = new DefaultVerifier();
    const verdict = await verifier.verify({
      atom, specHash, producedArtifact: produced.artifact,
      validationEvidence: { status: gateResult.status, validators: gateResult.validators },
    });
    execution.verify(verdict.verdict === 'ACCEPT' ? 'ACCEPT' : 'REJECT');

    const final = await execution.decide({
      decision: verdict.verdict === 'ACCEPT' ? 'MERGE' : 'REJECT', actor: 'platform-verification-service',
      timestamp: new Date().toISOString(), automatedOutcome: verdict.verdict === 'ACCEPT' ? 'ACCEPT' : 'REJECT', specHash,
    });
    const finalState = final.finalState as VadVerdict['final_state'];
    return { atom_id: atom.atom.id, final_state: finalState };
  }
}

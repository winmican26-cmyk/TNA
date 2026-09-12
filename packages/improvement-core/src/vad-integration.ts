import { finalizeAtomSpec, computeSpecHash } from '../../../packages/vad-core/src/index.js';
import { VadExecution, EvidenceStore } from '../../../packages/vad-runtime/src/index.js';
import { ValidationGate, type GateArtifacts, type ValidationRecord } from '../../../packages/validation-gate/src/index.js';
import { DefaultVerifier, type VerifierVerdict } from '../../../packages/verifier-core/src/index.js';
import { DeterministicMockProducer } from '../../../packages/model-adapter/src/index.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section C: real VAD integration for candidate
 * build acceptance. Mirrors `apps/tna-platform/src/vad-adapter.ts`'s `VadVerificationAdapter` exactly —
 * the same real atom-spec/producer/validation-gate/verifier/lifecycle sequence, never a re-implemented
 * or weakened parallel verifier. A candidate whose regression/security evidence did not really pass
 * feeds a real FAIL `ValidationRecord` into the real `ValidationGate`, which the real `DefaultVerifier`
 * then REJECTs on (`validationEvidence.status !== 'PASS'` → REJECT, `packages/verifier-core/src/index.ts`)
 * — this file invents no new acceptance logic of its own.
 */

export interface CandidateBuildVerificationInput {
  readonly generationId: string;
  readonly objective: string;
  readonly maxRuntimeSeconds: number;
  readonly maxCostUsd: number;
  /** Real, already-measured evidence (e.g. from `runPromotionEvaluation`'s regression/security run) —
   * never a candidate-asserted claim. */
  readonly regressionEvidence: readonly ValidationRecord[];
}

export interface CandidateBuildVerdict {
  readonly atomId: string;
  readonly specHash: string;
  readonly verifierVerdict: VerifierVerdict;
  readonly finalState: 'ACCEPTED' | 'REJECTED' | 'ESCALATED' | 'FAILED';
  readonly reasons: readonly string[];
}

/** Section C: "candidate produces artifact → VAD validation → independent verifier → ACCEPT/REJECT." A
 * candidate that improves its benchmark but fails this real VAD path is REJECTed here — the caller
 * (`runPromotionEvaluation` or the governor orchestration) must treat `finalState !== 'ACCEPTED'` as an
 * unconditional block on promotion eligibility, independent of anything the benchmark says. */
export async function verifyCandidateBuild(input: CandidateBuildVerificationInput): Promise<CandidateBuildVerdict> {
  const atom = finalizeAtomSpec({
    version: '1.0',
    atom: { id: `improvement-${input.generationId}`, title: input.objective.slice(0, 200) },
    goal: input.objective,
    success_criteria: [{ id: 'candidate-build-verified', description: 'The candidate build produced real, passing regression/security evidence', validation: 'deterministic' }],
    risk: { level: 'low' },
    resources: { read: ['**'], write: ['**'], create: ['**'] },
    constraints: { forbidden: [] },
    limits: { max_attempts: 1, max_runtime_seconds: input.maxRuntimeSeconds, max_cost_usd: input.maxCostUsd },
  });
  const store = new EvidenceStore();
  const execution = new VadExecution(atom, store);
  execution.ready();

  const producer = new DeterministicMockProducer();
  const produced = await producer.produce(atom, { artifacts: [], failure: null, priorConversation: [] });
  const gateArtifacts: GateArtifacts = {
    artifactHash: produced.artifact.artifactHash, diffHash: produced.artifact.diffHash,
    filesChanged: produced.artifact.filesChanged, declaredArtifacts: produced.artifact.declaredArtifacts,
    evidence: [...input.regressionEvidence],
  };
  const gateResult = await new ValidationGate().run(atom, gateArtifacts);
  execution.attempt({ passed: gateResult.status === 'PASS', artifactHash: produced.artifact.artifactHash, costUsd: produced.usage.cost });
  const specHash = computeSpecHash(atom);

  // Real VAD lifecycle rule (packages/vad-runtime/src/index.ts): a failed deterministic-gate attempt
  // never reaches VERIFYING at all — it goes straight to ESCALATED (or RETRYING, with attempts
  // remaining; this integration always uses max_attempts:1, so ESCALATED is the only reachable outcome).
  // There is no independent-verifier call to make in that case — the real lifecycle already terminated
  // the atom without one, and this function must report that real terminal state rather than force a
  // verify()/decide() call the lifecycle itself refuses.
  if (execution.lifecycle.current !== 'VERIFYING') {
    return {
      atomId: atom.atom.id, specHash, verifierVerdict: 'REJECT',
      finalState: execution.lifecycle.current as CandidateBuildVerdict['finalState'],
      reasons: ['Deterministic validation gate did not pass — the independent verifier was never reached (real VAD lifecycle rule, not this integration\'s own decision)'],
    };
  }

  const verdict = await new DefaultVerifier().verify({
    atom, specHash, producedArtifact: produced.artifact,
    validationEvidence: { status: gateResult.status, validators: gateResult.validators },
  });
  execution.verify(verdict.verdict === 'ACCEPT' ? 'ACCEPT' : 'REJECT');

  const final = await execution.decide({
    decision: verdict.verdict === 'ACCEPT' ? 'MERGE' : 'REJECT', actor: 'improvement-governor',
    timestamp: new Date().toISOString(), automatedOutcome: verdict.verdict === 'ACCEPT' ? 'ACCEPT' : 'REJECT', specHash,
  });

  return { atomId: atom.atom.id, specHash, verifierVerdict: verdict.verdict, finalState: final.finalState as CandidateBuildVerdict['finalState'], reasons: verdict.reasons };
}

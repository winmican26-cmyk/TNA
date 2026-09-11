import { createHash } from 'node:crypto';
import { computeSpecHash, type AtomSpec } from '../../vad-core/src/index.js';

export interface ProducerContext {
  artifacts: string[];
  failure: string | null;
  priorConversation: string[];
}

export interface ProducedArtifact {
  artifactHash: string;
  diffHash: string;
  filesChanged: string[];
  declaredArtifacts: string[];
  evidence?: Array<{
    validatorId: string;
    status: 'PASS' | 'FAIL' | 'NOT_RUN';
    exitCode?: number;
    summary: string;
    outputHash?: string;
  }>;
}

export interface ProducerResult {
  atom_id: string;
  spec_hash: string;
  attempt_number: number;
  producer_id: string;
  provider: string;
  model: string;
  model_version: string;
  started_at: string;
  completed_at: string;
  declared_output_artifacts: string[];
  artifact: ProducedArtifact;
  context: ProducerContext;
  usage: {
    tokens: number;
    cost: number;
    costType: 'measured' | 'estimated' | 'unknown';
  };
}

export class DeterministicMockProducer {
  async produce(atom: AtomSpec, context: ProducerContext): Promise<ProducerResult> {
    const attemptNumber = 1;
    const startedAt = new Date().toISOString();
    const artifact: ProducedArtifact = {
      artifactHash: createHash('sha256').update(JSON.stringify(context.artifacts)).digest('hex'),
      diffHash: createHash('sha256').update(JSON.stringify(context.failure ?? 'no-failure')).digest('hex'),
      filesChanged: context.artifacts,
      declaredArtifacts: context.artifacts,
    };

    return {
      atom_id: atom.atom.id,
      spec_hash: computeSpecHash(atom),
      attempt_number: attemptNumber,
      producer_id: 'deterministic-mock',
      provider: 'local',
      model: 'mock-producer',
      model_version: 'v0.1',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      declared_output_artifacts: context.artifacts,
      artifact,
      context: {
        artifacts: [...context.artifacts],
        failure: context.failure,
        priorConversation: [],
      },
      usage: {
        tokens: 0,
        cost: 0,
        costType: 'measured',
      },
    };
  }
}

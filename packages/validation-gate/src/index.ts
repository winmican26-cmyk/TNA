import { isResourceViolation, type AtomSpec } from '../../vad-core/src/index.js';

export interface ValidationRecord {
  validatorId: string;
  status: 'PASS' | 'FAIL' | 'NOT_RUN';
  exitCode?: number;
  summary: string;
  outputHash?: string;
}

export interface GateArtifacts {
  artifactHash: string;
  diffHash: string;
  filesChanged: string[];
  declaredArtifacts: string[];
  evidence: ValidationRecord[];
}

export interface GateResult {
  status: 'PASS' | 'FAIL';
  validators: ValidationRecord[];
  resourceViolation: boolean;
}

export class ValidationGate {
  async run(atom: AtomSpec, artifact: GateArtifacts): Promise<GateResult> {
    const evidence: ValidationRecord[] = (artifact.evidence.length === 0
      ? [{ validatorId: 'validation-gate', status: 'FAIL', summary: 'No deterministic evidence recorded' }]
      : artifact.evidence) as ValidationRecord[];
    const hasFailure = evidence.some((validator) => validator.status === 'FAIL');
    const hasNotRun = evidence.some((validator) => validator.status === 'NOT_RUN');
    const hasInvalidExit = evidence.some((validator) => validator.status === 'PASS' && validator.exitCode !== undefined && validator.exitCode !== 0);
    const resourceViolation = isResourceViolation(atom, artifact.filesChanged) || isResourceViolation(atom, artifact.declaredArtifacts);
    const status: 'PASS' | 'FAIL' = hasFailure || hasNotRun || hasInvalidExit || resourceViolation ? 'FAIL' : 'PASS';
    return { status, validators: evidence, resourceViolation };
  }
}

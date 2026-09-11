import { isResourceViolation, computeSpecHash, type AtomSpec } from '../../vad-core/src/index.js';
import { type GateArtifacts, type ValidationRecord } from '../../validation-gate/src/index.js';

export type VerifierVerdict = 'ACCEPT' | 'REJECT' | 'REQUEST_CHANGES' | 'INVALID';

export interface CriterionResult {
  criterionId: string;
  status: 'MET' | 'NOT_MET';
  evidence: string[];
}

export interface VerifierResult {
  verdict: VerifierVerdict;
  criteria: CriterionResult[];
  scopeViolations: string[];
  residualRisks: string[];
  reasons: string[];
}

export type VerificationArtifact = Omit<GateArtifacts, 'evidence'> & {
  evidence?: ValidationRecord[];
};

export interface VerificationInput {
  atom: AtomSpec;
  specHash: string;
  producedArtifact: VerificationArtifact;
  validationEvidence: {
    status: 'PASS' | 'FAIL';
    validators: ValidationRecord[];
  };
  customCriteria?: Array<{ id: string; status: 'MET' | 'NOT_MET' }>;
}

export class DefaultVerifier {
  async parse(input: unknown): Promise<VerifierResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Verifier output must be an object');
    const value = input as Record<string, unknown>;
    const allowed = new Set(['verdict', 'criteria', 'scopeViolations', 'residualRisks', 'reasons']);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Unknown verifier field: ${unknown}`);
    if (!['ACCEPT', 'REJECT', 'REQUEST_CHANGES'].includes(String(value.verdict))) throw new Error('Unknown verifier verdict');
    if (!Array.isArray(value.criteria) || !Array.isArray(value.scopeViolations) || !Array.isArray(value.residualRisks) || !Array.isArray(value.reasons)) {
      throw new Error('Verifier output criteria and reason arrays are required');
    }
    const criteria = value.criteria.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Malformed verifier criterion');
      const criterion = entry as Record<string, unknown>;
      const keys = Object.keys(criterion);
      if (keys.some((key) => !['criterionId', 'status', 'evidence'].includes(key))) throw new Error('Unknown verifier criterion field');
      if (typeof criterion.criterionId !== 'string' || !['MET', 'NOT_MET'].includes(String(criterion.status)) || !Array.isArray(criterion.evidence)) {
        throw new Error('Malformed verifier criterion');
      }
      if (!criterion.evidence.every((item) => typeof item === 'string')) throw new Error('Malformed verifier evidence mapping');
      return { criterionId: criterion.criterionId, status: criterion.status as 'MET' | 'NOT_MET', evidence: criterion.evidence as string[] };
    });
    const ids = criteria.map((criterion) => criterion.criterionId);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate verifier criterion');
    if (value.verdict === 'ACCEPT' && criteria.length === 0) throw new Error('ACCEPT verdict requires at least one criterion');
    if (value.verdict === 'ACCEPT' && criteria.some((criterion) => criterion.status !== 'MET')) throw new Error('ACCEPT contains unmet criterion');
    return {
      verdict: value.verdict as VerifierVerdict,
      criteria,
      scopeViolations: value.scopeViolations as string[],
      residualRisks: value.residualRisks as string[],
      reasons: value.reasons as string[],
    };
  }

  async verify(input: VerificationInput): Promise<VerifierResult> {
    // 1. Spec hash binding — mismatch means the atom was tampered with
    const expectedHash = computeSpecHash(input.atom);
    if (input.specHash !== expectedHash) {
      return {
        verdict: 'INVALID',
        criteria: [],
        scopeViolations: [],
        residualRisks: [],
        reasons: ['Spec hash mismatch: the provided specHash does not match the computed hash of the atom.'],
      };
    }

    // 2. Build criteria based on actual validator evidence, not auto-MET
    const passingValidators = input.validationEvidence.validators.filter((v) => v.status === 'PASS');
    const actualEvidence = passingValidators.map((v) => `validator:${v.validatorId}`);
    const criteria = input.atom.success_criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: (passingValidators.length > 0 ? 'MET' : 'NOT_MET') as 'MET' | 'NOT_MET',
      evidence: actualEvidence,
    }));

    if (input.customCriteria) {
      const invalidIds = input.customCriteria.filter((entry) => !input.atom.success_criteria.some((criterion) => criterion.id === entry.id));
      if (invalidIds.length > 0) {
        return {
          verdict: 'INVALID',
          criteria: [],
          scopeViolations: ['invented criterion'],
          residualRisks: [],
          reasons: ['Verifier returned a criterion not present in the original atom.'],
        };
      }
    }

    const resourceViolation = isResourceViolation(input.atom, input.producedArtifact.filesChanged);
    if (resourceViolation) {
      return {
        verdict: 'REJECT',
        criteria,
        scopeViolations: ['undeclared resource touched'],
        residualRisks: [],
        reasons: ['The produced artifacts exceeded the declared resource manifest.'],
      };
    }

    // 5. Empty validators means no evidence to support acceptance
    if (input.validationEvidence.validators.length === 0) {
      return {
        verdict: 'REJECT',
        criteria: input.atom.success_criteria.map((criterion) => ({
          criterionId: criterion.id,
          status: 'NOT_MET' as const,
          evidence: [],
        })),
        scopeViolations: [],
        residualRisks: [],
        reasons: ['No validation evidence provided to support acceptance.'],
      };
    }

    if (input.validationEvidence.status !== 'PASS') {
      return {
        verdict: 'REJECT',
        criteria,
        scopeViolations: [],
        residualRisks: [],
        reasons: ['Deterministic validation did not pass.'],
      };
    }

    const missingCriterion = input.atom.success_criteria.find((criterion) => !criteria.some((entry) => entry.criterionId === criterion.id));
    if (missingCriterion) {
      return {
        verdict: 'INVALID',
        criteria: [],
        scopeViolations: [],
        residualRisks: [],
        reasons: [`The verifier omitted ${missingCriterion.id}.`],
      };
    }

    return {
      verdict: 'ACCEPT',
      criteria,
      scopeViolations: [],
      residualRisks: [],
      reasons: ['All mandatory success criteria are satisfied.'],
    };
  }
}

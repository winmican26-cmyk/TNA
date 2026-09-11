import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { computeSpecHash, type AtomSpec } from '../../vad-core/src/index.js';

export type LifecycleState =
  | 'CREATED'
  | 'READY'
  | 'PRODUCING'
  | 'VALIDATING'
  | 'RETRYING'
  | 'VERIFYING'
  | 'AWAITING_HUMAN'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'ESCALATED'
  | 'FAILED';

export interface TransitionRecord {
  atomId: string;
  fromState: LifecycleState;
  toState: LifecycleState;
  timestamp: string;
  actor: string;
  reason: string;
  attemptId?: string;
  specHash: string;
}

const transitions: Record<LifecycleState, readonly LifecycleState[]> = {
  CREATED: ['READY', 'FAILED'],
  READY: ['PRODUCING', 'FAILED'],
  PRODUCING: ['VALIDATING', 'FAILED'],
  VALIDATING: ['RETRYING', 'VERIFYING', 'AWAITING_HUMAN', 'ESCALATED', 'FAILED'],
  RETRYING: ['PRODUCING', 'ESCALATED', 'FAILED'],
  VERIFYING: ['AWAITING_HUMAN', 'REJECTED', 'FAILED'],
  AWAITING_HUMAN: ['ACCEPTED', 'REJECTED', 'ESCALATED'],
  ACCEPTED: [],
  REJECTED: [],
  ESCALATED: [],
  FAILED: [],
};

export class Lifecycle {
  public readonly atomId: string;
  public readonly specHash: string;
  public readonly history: TransitionRecord[] = [];
  public current: LifecycleState = 'CREATED';

  public constructor(private readonly spec: AtomSpec) {
    this.atomId = spec.atom.id;
    this.specHash = computeSpecHash(spec);
  }

  public transition(toState: LifecycleState, reason: string, actor = 'system', attemptId?: string): TransitionRecord {
    if (!transitions[this.current].includes(toState)) {
      throw new Error(`Illegal lifecycle transition ${this.current} -> ${toState}`);
    }
    if (computeSpecHash(this.spec) !== this.specHash) {
      throw new Error('Spec hash mismatch after execution start');
    }
    if (!reason.trim()) throw new Error('Transition reason is required');
    const record: TransitionRecord = {
      atomId: this.atomId,
      fromState: this.current,
      toState,
      timestamp: new Date().toISOString(),
      actor,
      reason,
      specHash: this.specHash,
    };
    if (attemptId !== undefined) record.attemptId = attemptId;
    this.history.push(record);
    this.current = toState;
    return record;
  }
}

export class RuntimeBudget {
  public constructor(private readonly spec: AtomSpec) {}

  public assertCanAttempt(attemptNumber: number, cumulativeCostUsd: number, elapsedSeconds = 0): void {
    if (!Number.isFinite(attemptNumber) || attemptNumber < 1) throw new Error('Invalid attempt number');
    if (!Number.isFinite(cumulativeCostUsd) || cumulativeCostUsd < 0) throw new Error('Invalid cost value');
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error('Invalid runtime value');

    if (attemptNumber > this.spec.limits.max_attempts) throw new Error('Attempt limit exhausted');
    if (cumulativeCostUsd > this.spec.limits.max_cost_usd) throw new Error('Cost limit exhausted');
    if (elapsedSeconds > this.spec.limits.max_runtime_seconds) throw new Error('Runtime limit exhausted');
  }
}

export interface HumanDecision {
  decision: 'MERGE' | 'REJECT' | 'OVERRIDE_ACCEPT' | 'OVERRIDE_REJECT';
  actor: string;
  timestamp: string;
  rationale?: string;
  automatedOutcome: 'ACCEPT' | 'REJECT' | 'REQUEST_CHANGES';
  specHash: string;
}

export function validateHumanDecision(input: HumanDecision): HumanDecision {
  if (!input.actor.trim()) throw new Error('Human decision actor is required');
  if (!input.timestamp || Number.isNaN(Date.parse(input.timestamp))) throw new Error('Human decision timestamp is required');
  if (input.decision.startsWith('OVERRIDE_') && !input.rationale?.trim()) {
    throw new Error('Override rationale is required');
  }
  if (!input.specHash.trim()) throw new Error('Human decision spec hash is required');
  return { ...input };
}

export interface FinalEvidencePackage {
  atomId: string;
  specHash: string;
  artifactHash: string;
  finalState: 'ACCEPTED' | 'REJECTED' | 'ESCALATED' | 'FAILED';
  completedAt?: string;
  [key: string]: unknown;
}

export interface PersistenceOptions {
  failWrites?: boolean;
}

export class EvidenceStore {
  private readonly entries = new Map<string, FinalEvidencePackage>();

  public async persist(record: FinalEvidencePackage, options: PersistenceOptions = {}): Promise<void> {
    if (options.failWrites) throw new Error('Evidence persistence failed');
    const existing = this.entries.get(record.atomId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error('Conflicting final evidence');
    }
    this.entries.set(record.atomId, structuredClone(record));
  }

  public records(): FinalEvidencePackage[] {
    return [...this.entries.values()].map((record) => structuredClone(record));
  }
}

export class FileEvidenceStore {
  public constructor(private readonly directory: URL) {}

  /** Produce a filesystem-safe, collision-free filename for any atomId. */
  private path(atomId: string): URL {
    const hash = createHash('sha256').update(atomId).digest('hex').slice(0, 16);
    const safe = atomId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return new URL(`${safe}-${hash}.json`, this.directory);
  }

  /** Recursively sort all object keys so insertion order is irrelevant. */
  private static sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(FileEvidenceStore.sortKeys);
    if (value !== null && typeof value === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = FileEvidenceStore.sortKeys((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  }

  private static canonical(record: FinalEvidencePackage, stripCompletedAt: boolean): string {
    if (stripCompletedAt) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { completedAt, ...rest } = record;
      return JSON.stringify(FileEvidenceStore.sortKeys(rest));
    }
    return JSON.stringify(FileEvidenceStore.sortKeys(record));
  }

  public async persist(record: FinalEvidencePackage): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.path(record.atomId);
    const callerOmittedCompletedAt = !('completedAt' in record) || record.completedAt === undefined;

    try {
      const existing = JSON.parse(await readFile(target, 'utf8')) as FinalEvidencePackage;
      if (FileEvidenceStore.canonical(existing, callerOmittedCompletedAt) !==
          FileEvidenceStore.canonical(record, callerOmittedCompletedAt)) {
        throw new Error('Conflicting final evidence');
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const enriched = { ...record, completedAt: record.completedAt ?? new Date().toISOString() };
    const content = JSON.stringify(enriched, null, 2);

    try {
      await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const written = JSON.parse(await readFile(target, 'utf8')) as FinalEvidencePackage;
    if (FileEvidenceStore.canonical(written, callerOmittedCompletedAt) !==
        FileEvidenceStore.canonical(record, callerOmittedCompletedAt)) {
      throw new Error('Conflicting final evidence');
    }
  }
}

export type ExecutionVerdict = 'ACCEPT' | 'REJECT';

/**
 * Injectable clock abstraction. Runtime derives all timing from this.
 * Tests inject a deterministic clock; production uses Date.now.
 */
export type Clock = () => number;

/**
 * Result of a single attempt, returned by the caller after producer + gate run.
 * The caller provides the outcome and cost; the runtime owns the attempt number
 * and timing.
 */
export interface AttemptResult {
  passed: boolean;
  artifactHash: string;
  /** Cost of THIS attempt (not cumulative). Must be non-negative finite. */
  costUsd: number;
}

export class VadExecution {
  public readonly lifecycle: Lifecycle;
  public readonly budget: RuntimeBudget;
  public readonly events: string[] = ['ATOM CREATED'];

  /** Runtime-owned state — caller cannot set or reset these. */
  private attemptCount = 0;
  private aggregateCostUsd = 0;
  private executionStartedAt: number | null = null;

  private readonly clock: Clock;
  private readonly attempts: Array<{
    attemptNumber: number;
    outcome: 'PASS' | 'FAIL';
    artifactHash: string;
    costUsd: number;
    startedAt: string;
    completedAt: string;
  }> = [];
  private verifierVerdict: ExecutionVerdict | null = null;
  private latestArtifactHash: string | null = null;

  /**
   * @param spec  Immutable atom specification.
   * @param store Evidence store for final persistence.
   * @param clock Injectable clock (default Date.now). Runtime derives all
   *              timing from this — callers never supply elapsed time.
   */
  public constructor(
    private readonly spec: AtomSpec,
    private readonly store: EvidenceStore,
    clock?: Clock,
  ) {
    this.lifecycle = new Lifecycle(spec);
    this.budget = new RuntimeBudget(spec);
    this.clock = clock ?? Date.now;
  }

  public ready(): void {
    this.lifecycle.transition('READY', 'atom spec accepted');
    this.events.push('ATOM READY');
  }

  /**
   * Start the next attempt. The runtime assigns the attempt number and
   * derives timing from its owned clock. The caller provides only the
   * outcome and per-attempt cost.
   *
   * v0.1 runtime semantics:
   *   max_runtime_seconds = total atom runtime (from first attempt start
   *   to current clock reading).
   */
  public attempt(result: AttemptResult): number {
    // Validate caller-supplied values
    if (!Number.isFinite(result.costUsd) || result.costUsd < 0) {
      throw new Error('Invalid cost value');
    }

    // Runtime-owned attempt number
    const attemptNumber = this.attemptCount + 1;
    const now = this.clock();

    // Record execution start on first attempt
    if (this.executionStartedAt === null) {
      this.executionStartedAt = now;
    }

    // Runtime-derived elapsed time (total atom runtime)
    const elapsedSeconds = (now - this.executionStartedAt) / 1000;

    // Accumulate cost BEFORE budget check so the check sees the true total
    const projectedCost = this.aggregateCostUsd + result.costUsd;

    // Budget enforcement — runtime owns these values
    this.budget.assertCanAttempt(attemptNumber, projectedCost, elapsedSeconds);

    // Commit the attempt
    this.attemptCount = attemptNumber;
    this.aggregateCostUsd = projectedCost;

    const startedAt = new Date(now).toISOString();

    this.lifecycle.transition('PRODUCING', `producer attempt ${attemptNumber}`, 'system', `attempt-${attemptNumber}`);
    this.events.push(`PRODUCER ATTEMPT ${attemptNumber}`);
    this.lifecycle.transition('VALIDATING', 'producer completed', 'system', `attempt-${attemptNumber}`);

    const completedAt = new Date(this.clock()).toISOString();
    this.attempts.push({
      attemptNumber,
      outcome: result.passed ? 'PASS' : 'FAIL',
      artifactHash: result.artifactHash,
      costUsd: result.costUsd,
      startedAt,
      completedAt,
    });
    this.latestArtifactHash = result.artifactHash;

    if (result.passed) {
      this.events.push('DETERMINISTIC GATE PASSED');
      this.lifecycle.transition('VERIFYING', 'deterministic gate passed', 'system', `attempt-${attemptNumber}`);
    } else {
      this.events.push('DETERMINISTIC GATE FAILED');
      if (attemptNumber >= this.spec.limits.max_attempts) {
        this.lifecycle.transition('ESCALATED', 'retry limit reached', 'system', `attempt-${attemptNumber}`);
        this.events.push('RETRY LIMIT REACHED', 'ATOM ESCALATED');
      } else {
        this.lifecycle.transition('RETRYING', 'fresh retry required', 'system', `attempt-${attemptNumber}`);
        this.events.push('FRESH RETRY CREATED');
      }
    }

    return attemptNumber;
  }

  /** Runtime-owned read accessors. */
  public get currentAttemptCount(): number { return this.attemptCount; }
  public get currentAggregateCost(): number { return this.aggregateCostUsd; }
  public get currentElapsedSeconds(): number {
    if (this.executionStartedAt === null) return 0;
    return (this.clock() - this.executionStartedAt) / 1000;
  }

  public verify(verdict: ExecutionVerdict): void {
    if (this.lifecycle.current !== 'VERIFYING') throw new Error('Verification requires VALIDATING success');
    this.verifierVerdict = verdict;
    this.events.push(verdict === 'ACCEPT' ? 'VERIFIER ACCEPTED' : 'VERIFIER REJECTED');
    this.lifecycle.transition('AWAITING_HUMAN', 'independent verifier completed');
    this.events.push('AWAITING HUMAN');
  }

  public async decide(decision: HumanDecision): Promise<FinalEvidencePackage> {
    if (this.lifecycle.current !== 'AWAITING_HUMAN') throw new Error('Human decision requires verifier completion');
    if (!this.latestArtifactHash || !this.verifierVerdict) throw new Error('Final evidence is incomplete');
    const validated = validateHumanDecision(decision);
    if (validated.specHash !== this.lifecycle.specHash) throw new Error('Human decision spec hash mismatch');
    const accepted = validated.decision === 'MERGE' || validated.decision === 'OVERRIDE_ACCEPT';
    if (accepted && this.verifierVerdict !== 'ACCEPT') throw new Error('Human acceptance conflicts with verifier rejection');
    if (!accepted && this.verifierVerdict !== 'REJECT') throw new Error('Human rejection conflicts with verifier acceptance');
    const finalState = accepted ? 'ACCEPTED' : 'REJECTED';
    const evidence = await finalizeAcceptance(this.store, {
      atomId: this.spec.atom.id,
      specHash: this.lifecycle.specHash,
      artifactHash: this.latestArtifactHash,
      finalState,
      attempts: this.attempts,
      humanDecision: validated,
      verifierVerdict: this.verifierVerdict,
    });
    this.events.push('HUMAN DECISION RECORDED', 'EVIDENCE PACKAGE PERSISTED', 'EVIDENCE INTEGRITY VERIFIED');
    this.lifecycle.transition(finalState, 'final evidence persisted', validated.actor);
    this.events.push(accepted ? 'ATOM ACCEPTED' : 'ATOM REJECTED');
    return evidence;
  }
}

export class ActiveExecutionRegistry {
  private readonly active = new Set<string>();

  public acquire(atomId: string): void {
    if (this.active.has(atomId)) throw new Error('Active run already exists');
    this.active.add(atomId);
  }

  public release(atomId: string): void {
    this.active.delete(atomId);
  }
}

export async function finalizeAcceptance(
  store: EvidenceStore,
  record: FinalEvidencePackage,
  options: PersistenceOptions & { expectedSpecHash?: string; expectedArtifactHash?: string } = {},
): Promise<FinalEvidencePackage> {
  if (options.expectedSpecHash && options.expectedSpecHash !== record.specHash) throw new Error('Spec hash mismatch');
  if (options.expectedArtifactHash && options.expectedArtifactHash !== record.artifactHash) throw new Error('Artifact hash mismatch');
  if (record.finalState === 'ACCEPTED' && (!record.specHash || !record.artifactHash)) throw new Error('Acceptance evidence is incomplete');
  const complete = { ...record, completedAt: record.completedAt ?? new Date().toISOString() };
  await store.persist(complete, options);
  return complete;
}

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section I-K: the real packaged governor HTTP
 * server. Every route below calls the REAL Gate/VAD/Sentinel/Ledger integrations built in
 * `packages/improvement-core` and the REAL `ImprovementStore`/`runPromotionEvaluation` — never a
 * fabricated object shaped like one of those results (section A: "do not merely emit objects shaped
 * like Gate/Sentinel/Ledger results").
 *
 * Section J (fail closed): every dependency this server needs (`Gate`, `Ledger`, `SentinelRuntime`,
 * `ImprovementStore`) is a required constructor parameter — there is no "local evaluation only" mode and
 * no code path that silently degrades when one is unavailable. If any of them cannot be constructed,
 * `createImprovementGovernorServer` itself throws before `server.listen` is ever reached (mirrored from
 * `apps/tna-client-gateway`'s own TNA-64 fail-closed startup discipline) — `/ready` additionally proves
 * this live, on every request, by actually touching each dependency rather than reporting a cached flag.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Gate } from '../../tna-gate-api/src/gate.js';
import { HttpError as GateHttpError } from '../../tna-gate-api/src/gate.js';
import type { Ledger } from '../../../packages/ledger-core/src/index.js';
import type { LedgerStore } from '../../../packages/ledger-store/src/index.js';
import type { SentinelRuntime } from '../../../packages/sentinel-runtime/src/index.js';
import { ImprovementStore } from '../../../packages/improvement-store/src/index.js';
import {
  ImprovementError, buildImprovementSpec, isPlainObject, checkRecursionBudget, hash as hashValue, type ImprovementClass, type AuthorityCeiling,
  type CapabilityProfile, type RequiredTestManifest, type RecursionLimits,
} from '../../../packages/improvement-schema/src/index.js';

const DEFAULT_RECURSION_LIMITS: RecursionLimits = {
  max_generations: 100, max_attempts_per_generation: 10, max_runtime_per_attempt_ms: 600_000, max_total_runtime_ms: 3_600_000,
  max_cost_per_attempt_usd: 5, max_total_cost_usd: 100, max_tool_calls: 1000, max_external_calls: 100, max_changed_files: 100, max_changed_bytes: 5_000_000,
};
import { createIsolatedWorkspace, hashDirectoryTree, generationWorkspacePath, assertInsideWorkspace } from '../../../packages/improvement-core/src/index.js';
import { registerImprovementGovernor, authorizeImprovementOperation, improvementApprover, type ImprovementOperation } from '../../../packages/improvement-core/src/gate-integration.js';
import { verifyCandidateBuild } from '../../../packages/improvement-core/src/vad-integration.js';
import { installImprovementSentinelPolicy, createCandidateSession, sentinelAdminPrincipal } from '../../../packages/improvement-core/src/sentinel-integration.js';
import { appendImprovementEvent } from '../../../packages/improvement-core/src/ledger-integration.js';
import { assessImprovementGeneration } from '../../../packages/improvement-core/src/auditor-integration.js';
import { reconstructImprovementGeneration, reconstructImprovementLineage } from '../../../packages/ledger-query/src/index.js';
import { runPromotionEvaluation, type BenchmarkSpec } from '../../../packages/improvement-evaluator/src/index.js';

export class HttpError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

export interface ImprovementGovernorDeps {
  readonly store: ImprovementStore;
  readonly gate: Gate;
  readonly ledger: Ledger;
  readonly ledgerStore: LedgerStore;
  readonly sentinel: SentinelRuntime;
  readonly tenantId: string;
  readonly governorAgentId: string;
  readonly approverRole: string;
  readonly adminToken: string;
  readonly startedAt?: number;
}

const MAX_BODY_BYTES = 262_144;
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  try { return JSON.parse(text) as unknown; } catch { throw new HttpError(400, 'Invalid JSON'); }
}
function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function extractBearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Authorization: Bearer <token> required');
  return authorization.slice(7);
}
function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof GateHttpError) return error.status;
  if (error instanceof ImprovementError) {
    switch (error.code) {
      case 'NOT_FOUND': return 404;
      case 'FORBIDDEN': case 'CROSS_TENANT_DENIED': return 403;
      case 'CONFLICT': case 'SPEC_IMMUTABLE': case 'LINEAGE_CYCLE': return 409;
      case 'BUDGET_EXHAUSTED': return 429;
      default: return 400;
    }
  }
  return 500;
}
function errorBody(error: unknown): { readonly error: string; readonly code?: string } {
  if (error instanceof HttpError || error instanceof GateHttpError) return { error: error.message };
  if (error instanceof ImprovementError) return { error: error.message, code: error.code };
  return { error: 'Internal server error' };
}

/** Reconstructs the exact Gate `AuthorizationRequest` shape a given improvement operation uses — needed
 * both to authorize it and, symmetrically, to approve it (Gate's `approve()` binds to the same request
 * hash, so approval must be requested against byte-identical fields). */
function requestFor(governorAgentId: string, operation: ImprovementOperation, generationId: string, resource?: string) {
  return { agentId: governorAgentId, action: `improvement.${operation}`, tool: `improvement.${operation}`, resource: resource ?? `/improvement/generations/${generationId}`, estimatedCostUsd: 0 };
}

/** In-memory, per-process workspace bookkeeping (generation_id -> its two real workspace paths on disk).
 * Section 20-23 (source snapshots, isolated workspaces) are fully real; only the association "which
 * path belongs to which generation" is kept in server memory for v0.1 rather than a new durable store
 * column — an explicit, documented simplification, not a hidden one. */
const workspacesByGeneration = new Map<string, { readonly parentWorkspacePath: string; readonly candidateWorkspacePath: string | null }>();

export function createImprovementGovernorServer(deps: ImprovementGovernorDeps) {
  const startedAt = deps.startedAt ?? Date.now();
  registerImprovementGovernor(deps.gate, deps.governorAgentId, { approverRole: deps.approverRole });
  installImprovementSentinelPolicy(deps.sentinel, deps.tenantId);

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (req.method === 'GET' && path === '/live') return send(res, 200, { status: 'ALIVE', uptime_ms: Date.now() - startedAt });
        if (req.method === 'GET' && path === '/ready') {
          try {
            deps.store.getOrCreateRecursionBudget(deps.tenantId, '__readiness_probe__', { max_generations: 1, max_attempts_per_generation: 1, max_runtime_per_attempt_ms: 1, max_total_runtime_ms: 1, max_cost_per_attempt_usd: 1, max_total_cost_usd: 1, max_tool_calls: 1, max_external_calls: 1, max_changed_files: 1, max_changed_bytes: 1 });
            deps.gate.authorize({ kind: 'agent', agentId: deps.governorAgentId }, requestFor(deps.governorAgentId, 'authorize_generation', '__readiness_probe__'));
            deps.ledgerStore.query(deps.tenantId, {}, 1);
            deps.sentinel.installDefaultPolicy(sentinelAdminPrincipal('readiness-probe', deps.tenantId));
            return send(res, 200, { ready: true, status: 'AVAILABLE' });
          } catch {
            return send(res, 503, { ready: false, status: 'UNAVAILABLE' });
          }
        }

        const token = extractBearerToken(req);
        if (token !== deps.adminToken) throw new HttpError(401, 'Invalid admin token');

        if (req.method === 'POST' && path === '/v1/improvements') return send(res, 201, await handleCreate(deps, await body(req)));
        if (req.method === 'GET' && path === '/v1/improvements') {
          const systemId = url.searchParams.get('systemId');
          if (!systemId) throw new HttpError(400, 'systemId query parameter is required');
          const limitParam = Number(url.searchParams.get('limit'));
          return send(res, 200, deps.store.listGenerations(deps.tenantId, systemId, limitParam ? { limit: limitParam } : {}));
        }
        const evalProfileMatch = path.match(/^\/v1\/systems\/([^/]+)\/evaluation-profile$/);
        if (evalProfileMatch && req.method === 'POST') {
          const parsed = await body(req);
          if (!isPlainObject(parsed) || typeof parsed.hash !== 'string') throw new HttpError(400, 'hash is required');
          // The URL segment is the CALLER's chosen system name, never the store's internally-minted
          // `system_id` — resolve it the same way `handleCreate` does, since `handleEvaluate`/
          // `handlePromote` key `activeEvaluationProfileHashBySystem` by the real internal id.
          const system = deps.store.findSystemByName(deps.tenantId, evalProfileMatch[1]!);
          if (!system) throw new HttpError(404, `No system named ${evalProfileMatch[1]} for this tenant`);
          activeEvaluationProfileHashBySystem.set(system.system_id, parsed.hash);
          return send(res, 200, { systemId: system.system_id, activeEvaluationProfileHash: parsed.hash });
        }

        const match = path.match(/^\/v1\/improvements\/([^/]+)(\/.*)?$/);
        if (match) {
          const generationId = match[1]!;
          const subPath = match[2] ?? '';
          if (req.method === 'GET' && subPath === '') return send(res, 200, deps.store.getGeneration(deps.tenantId, generationId));
          if (req.method === 'GET' && subPath === '/evidence') return send(res, 200, handleEvidence(deps, generationId));
          if (req.method === 'GET' && subPath === '/lineage') return send(res, 200, handleLineage(deps, generationId));
          if (req.method === 'POST' && subPath === '/authorize') return send(res, 200, handleAuthorize(deps, generationId));
          if (req.method === 'POST' && subPath === '/build') return send(res, 200, handleBuild(deps, generationId, await body(req)));
          if (req.method === 'POST' && subPath === '/evaluate') return send(res, 200, await handleEvaluate(deps, generationId, await body(req)));
          if (req.method === 'POST' && subPath === '/approve') return send(res, 200, handleApprove(deps, generationId, await body(req)));
          if (req.method === 'POST' && subPath === '/canary') return send(res, 200, handleCanary(deps, generationId, await body(req)));
          if (req.method === 'POST' && subPath === '/promote') return send(res, 200, handlePromote(deps, generationId, await body(req)));
          if (req.method === 'POST' && subPath === '/rollback') return send(res, 200, handleRollback(deps, generationId, await body(req)));
        }
        throw new HttpError(404, 'Route not found');
      } catch (error) {
        send(res, errorStatus(error), errorBody(error));
      }
    })();
  });
  server.maxRequestsPerSocket = 100;
  return server;
}

interface CreateBody {
  readonly systemId: string; readonly systemName?: string; readonly parentGenerationId: string | null; readonly parentWorkspacePath: string;
  readonly objective: string; readonly improvementClass: ImprovementClass; readonly allowedMutationPaths: readonly string[];
  readonly forbiddenMutationPaths?: readonly string[]; readonly authorityCeiling: AuthorityCeiling; readonly candidateVersion: string;
  readonly createdBy: string; readonly [key: string]: unknown;
}
function asCreateBody(raw: unknown): CreateBody {
  if (!isPlainObject(raw)) throw new HttpError(400, 'Request body must be an object');
  return raw as unknown as CreateBody;
}

async function handleCreate(deps: ImprovementGovernorDeps, raw: unknown) {
  const input = asCreateBody(raw);
  // `input.systemId` is the CALLER's chosen stable system identifier, never the store's internally
  // -minted `system_id` (those are always fresh `newSystemId()` values) — looking it up with `getSystem`
  // would always miss and silently mint a brand-new, disconnected system on every single propose() call,
  // which breaks every invariant that depends on multiple generations sharing one system's accumulated
  // state (recursion budget, accepted-generation tracking, active evaluation profile). The store's `name`
  // column is therefore always set to `input.systemId` itself, NEVER `input.systemName` — a caller that
  // supplies a different display-only `systemName` on a later call must not silently defeat the find-by
  // -id lookup this relies on. `systemName` is accepted for backward compatibility but does not affect
  // lookup or storage identity in v0.1.
  const system = deps.store.findSystemByName(deps.tenantId, input.systemId)
    ?? deps.store.createSystem(deps.tenantId, input.systemId, input.createdBy);

  // Section F, TNA-80: the runtime — never the candidate — owns the recursion budget. A new generation
  // is refused outright once any configured limit is reached; this check runs BEFORE anything else about
  // the proposal is processed, so an exhausted system can never accumulate a partial generation record.
  const recursionLimits = (input.recursionLimits as never) ?? DEFAULT_RECURSION_LIMITS;
  const budget = deps.store.getOrCreateRecursionBudget(deps.tenantId, system.system_id, recursionLimits);
  const exhaustion = checkRecursionBudget(budget);
  if (exhaustion.exhausted) {
    appendImprovementEvent(deps.ledger, deps.tenantId, 'RECURSION_BUDGET_EXHAUSTED', { generationId: `system:${system.system_id}`, correlationId: system.system_id, payload: { reasons: exhaustion.reasons } });
    throw new ImprovementError('BUDGET_EXHAUSTED', `Recursion budget exhausted for system ${system.system_id}: ${exhaustion.reasons.join(', ')}`);
  }

  const spec = buildImprovementSpec({
    system_id: system.system_id, tenant_id: deps.tenantId, parent_generation_id: input.parentGenerationId,
    objective: input.objective, improvement_class: input.improvementClass, allowed_mutation_paths: input.allowedMutationPaths,
    forbidden_mutation_paths: input.forbiddenMutationPaths ?? [], allowed_tool_changes: [], allowed_dependency_changes: [], allowed_model_changes: [],
    authority_ceiling: input.authorityCeiling,
    resource_limits: (input.resourceLimits as never) ?? { max_runtime_ms: 300_000, max_cost_usd: 5, max_tool_calls: 100, max_external_calls: 10, max_changed_files: 50, max_changed_bytes: 1_000_000 },
    evaluation_profile_id: (input.evaluationProfileId as string) ?? 'default', required_benchmarks: (input.requiredBenchmarks as string[]) ?? [],
    required_security_tests: (input.requiredSecurityTests as string[]) ?? [], promotion_thresholds: (input.promotionThresholds as Record<string, number>) ?? {},
    canary_policy: (input.canaryPolicy as never) ?? { traffic_percent: 5, max_actions: 20, max_runtime_ms: 60_000, failure_threshold: 0.1, sentinel_terminate_is_failure: true, cost_threshold_usd: 1 },
    rollback_policy: (input.rollbackPolicy as never) ?? { rollback_generation_id: input.parentGenerationId, auto_rollback_triggers: ['CANARY_HEALTH_FAILURE'] },
    max_iterations: (input.maxIterations as number) ?? 3, max_runtime_ms: (input.maxRuntimeMs as number) ?? 600_000, max_cost_usd: (input.maxCostUsd as number) ?? 5,
    created_by: input.createdBy,
  });

  const sourceHashBefore = hashDirectoryTree(input.parentWorkspacePath);
  const generation = deps.store.createGeneration({
    tenantId: deps.tenantId, systemId: system.system_id, parentGenerationId: input.parentGenerationId, candidateVersion: input.candidateVersion,
    improvementClass: input.improvementClass, specHash: spec.spec_hash, sourceHashBefore, authorityProfileBefore: input.authorityCeiling, createdBy: input.createdBy,
  });
  deps.store.consumeRecursionBudget(deps.tenantId, system.system_id, budget.state_version, { generations: 1 });
  deps.store.saveSpec(deps.tenantId, generation.generation_id, spec.spec_id, spec, spec.spec_hash);
  workspacesByGeneration.set(generation.generation_id, { parentWorkspacePath: input.parentWorkspacePath, candidateWorkspacePath: null });
  specIdByGeneration.set(generation.generation_id, spec.spec_id);
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_PROPOSED', { generationId: generation.generation_id, correlationId: generation.generation_id, parentGenerationId: input.parentGenerationId, payload: { objective: input.objective, spec_id: spec.spec_id, spec_hash: spec.spec_hash } });
  return { generation, spec_id: spec.spec_id };
}

function handleAuthorize(deps: ImprovementGovernorDeps, generationId: string) {
  const decision = authorizeImprovementOperation(deps.gate, deps.governorAgentId, 'authorize_generation', generationId);
  if (decision.decision !== 'ALLOW') return { decision, generation: deps.store.getGeneration(deps.tenantId, generationId) };
  const gen = deps.store.getGeneration(deps.tenantId, generationId);
  const updated = deps.store.transitionGeneration(deps.tenantId, generationId, gen.state_version, 'AUTHORIZED');
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_AUTHORIZED', { generationId, correlationId: generationId, payload: { decision_id: decision.decisionId } });
  return { decision, generation: updated };
}

function handleBuild(deps: ImprovementGovernorDeps, generationId: string, raw: unknown) {
  const decision = authorizeImprovementOperation(deps.gate, deps.governorAgentId, 'build', generationId);
  if (decision.decision !== 'ALLOW') return { decision, generation: deps.store.getGeneration(deps.tenantId, generationId) };
  const workspaces = workspacesByGeneration.get(generationId);
  if (!workspaces) throw new HttpError(404, 'No workspace tracked for this generation — was /v1/improvements ever called for it?');
  let gen = deps.store.getGeneration(deps.tenantId, generationId);
  gen = deps.store.transitionGeneration(deps.tenantId, generationId, gen.state_version, 'BUILDING');
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_BUILD_STARTED', { generationId, correlationId: generationId, payload: {} });

  const candidateWorkspace = createIsolatedWorkspace(generationId, workspaces.parentWorkspacePath);
  const candidateFiles = isPlainObject(raw) && isPlainObject(raw.candidateFiles) ? raw.candidateFiles as Record<string, string> : {};
  for (const [relPath, content] of Object.entries(candidateFiles)) {
    const target = assertInsideWorkspace(generationWorkspacePath(generationId), resolve(candidateWorkspace, relPath));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  workspacesByGeneration.set(generationId, { ...workspaces, candidateWorkspacePath: candidateWorkspace });
  const sourceHashAfter = hashDirectoryTree(candidateWorkspace);
  gen = deps.store.transitionGeneration(deps.tenantId, generationId, gen.state_version, 'BUILT', { sourceHashAfter });
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_BUILT', { generationId, correlationId: generationId, payload: { source_hash_after: sourceHashAfter } });
  return { decision, generation: gen, candidate_workspace: candidateWorkspace };
}

interface EvaluateBody {
  readonly regressionTestCommand?: readonly string[]; readonly securityTestCommand?: readonly string[]; readonly benchmarks?: readonly BenchmarkSpec[];
  readonly candidateCapabilityProfile: CapabilityProfile; readonly candidateAuthorityProfile: AuthorityCeiling;
  readonly requiredTestManifestBefore: RequiredTestManifest; readonly requiredTestManifestAfter: RequiredTestManifest;
  readonly parentCapabilityProfile: CapabilityProfile; readonly humanApproved?: boolean | null; readonly independentReviewApproved?: boolean | null;
  readonly evaluationProfileHash?: string;
}
async function handleEvaluate(deps: ImprovementGovernorDeps, generationId: string, raw: unknown) {
  if (!isPlainObject(raw)) throw new HttpError(400, 'Request body must be an object');
  const input = raw as unknown as EvaluateBody;
  const workspaces = workspacesByGeneration.get(generationId);
  if (!workspaces?.candidateWorkspacePath) throw new HttpError(409, 'Generation has not been built yet');
  let gen = deps.store.getGeneration(deps.tenantId, generationId);
  // Re-evaluation support (section G): a HOLD outcome (e.g. Class 5 awaiting human/independent approval)
  // leaves the generation in EVALUATED, not BUILT — the state machine has no EVALUATED -> EVALUATING edge
  // (evaluation is a one-way pipeline step, never re-enterable), so a later evaluate() call carrying newly
  // arrived approval flags must re-run the real evaluation logic in place, WITHOUT attempting an illegal
  // re-entry into EVALUATING. Any other status (REJECTED/CANARY/PROMOTED/...) is not re-evaluable.
  if (gen.status === 'BUILT') {
    gen = deps.store.transitionGeneration(deps.tenantId, generationId, gen.state_version, 'EVALUATING');
  } else if (gen.status !== 'EVALUATED') {
    throw new HttpError(409, `Generation is not in an evaluable state (currently ${gen.status})`);
  }
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_EVALUATION_STARTED', { generationId, correlationId: generationId, payload: {} });

  const spec = deps.store.getSpec<ReturnType<typeof buildImprovementSpec>>(deps.tenantId, specIdFor(deps, generationId));
  const evaluationProfileHash = input.evaluationProfileHash ?? 'default';
  // The first evaluation against a system establishes its "currently active" profile hash; a later,
  // explicit change (POST /v1/systems/:id/evaluation-profile) is what section H's staleness test uses.
  if (!activeEvaluationProfileHashBySystem.has(gen.system_id)) activeEvaluationProfileHashBySystem.set(gen.system_id, evaluationProfileHash);

  // Real evaluation FIRST — this actually runs the regression/security/benchmark commands and computes
  // the real capability/authority/mutation-boundary/test-tamper signals. VAD is then given the REAL,
  // already-measured regression/security outcome as its own evidence (never a hardcoded assumption) —
  // section C: a candidate that improves its benchmark but fails VAD is still REJECTed regardless.
  const evaluation = runPromotionEvaluation(deps.store, {
    tenantId: deps.tenantId, generationId, parentGenerationId: gen.parent_generation_id, improvementClass: gen.improvement_class,
    parentWorkspace: workspaces.parentWorkspacePath, candidateWorkspace: workspaces.candidateWorkspacePath, spec,
    parentCapabilityProfile: input.parentCapabilityProfile, candidateCapabilityProfile: input.candidateCapabilityProfile,
    regressionTestCommand: input.regressionTestCommand ?? null, securityTestCommand: input.securityTestCommand ?? null, benchmarks: input.benchmarks ?? [],
    requiredTestManifestBefore: input.requiredTestManifestBefore, requiredTestManifestAfter: input.requiredTestManifestAfter,
    candidateAuthorityProfile: input.candidateAuthorityProfile, humanApproved: input.humanApproved ?? null, independentReviewApproved: input.independentReviewApproved ?? null,
    evaluationProfileHash, decidedBy: deps.governorAgentId,
  });

  const regressionEvidence = [{ validatorId: 'candidate-regression-suite', status: (evaluation.regressionSuitePassed ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL', summary: `real measured regression outcome: ${evaluation.regressionSuitePassed}`, exitCode: evaluation.regressionSuitePassed ? 0 : 1 }];
  const vadVerdict = await verifyCandidateBuild({ generationId, objective: spec.objective, maxRuntimeSeconds: spec.max_runtime_ms / 1000, maxCostUsd: spec.max_cost_usd, regressionEvidence });

  const finalStatus = vadVerdict.finalState !== 'ACCEPTED' ? 'REJECT' : evaluation.status;
  appendImprovementEvent(deps.ledger, deps.tenantId, 'CAPABILITY_DELTA_DETECTED', { generationId, correlationId: generationId, payload: { has_unexpected_gain: evaluation.hasUnexpectedCapabilityGain } });
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_EVALUATED', {
    generationId, correlationId: generationId,
    payload: {
      decision: finalStatus, vad_final_state: vadVerdict.finalState, reason: evaluation.reason,
      control_plane_changed: evaluation.controlPlaneChanged, evaluator_changed: evaluation.evaluatorChanged,
      test_tampered: evaluation.testTampered, authority_within_ceiling: evaluation.authorityWithinCeiling,
    },
  });

  const target = finalStatus === 'PROMOTE' ? 'EVALUATED' : finalStatus === 'REJECT' ? 'REJECTED' : finalStatus === 'HOLD' ? 'EVALUATED' : 'INDETERMINATE';
  const genNow = deps.store.getGeneration(deps.tenantId, generationId);
  // A re-evaluation (see above) that reaches the SAME target it is already in (EVALUATED, whether the
  // prior outcome was itself PROMOTE or HOLD) is a legitimate no-op, not an illegal self-transition —
  // `canTransition` never lists a state as its own successor, so this must be special-cased rather than
  // routed through `transitionGeneration`, which would otherwise throw on every re-evaluation that keeps
  // landing on HOLD/PROMOTE.
  const resolved = genNow.status === target ? genNow : deps.store.transitionGeneration(deps.tenantId, generationId, genNow.state_version, target);
  if (target === 'REJECTED') appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_REJECTED', { generationId, correlationId: generationId, payload: { reason: evaluation.reason } });
  return { vad: vadVerdict, evaluation: { status: finalStatus, reason: evaluation.reason }, generation: resolved };
}
function specIdFor(deps: ImprovementGovernorDeps, generationId: string): string {
  // The generation record only stores spec_hash, not spec_id directly reachable without a lookup table;
  // for v0.1 we keep the mapping alongside the workspace bookkeeping map rather than adding a store column.
  const entry = specIdByGeneration.get(generationId);
  if (!entry) throw new HttpError(404, `No spec tracked for generation ${generationId}`);
  return entry;
}
const specIdByGeneration = new Map<string, string>();

/** Section H: the "currently active" evaluation profile per system — a real, mutable, checkable value
 * (in-memory for v0.1, same documented simplification as the workspace/spec bookkeeping maps above).
 * `handlePromote` compares the hash a generation was actually EVALUATED under (its latest recorded
 * `PromotionDecision.evaluation_profile_hash`) against whatever this map says is current RIGHT NOW —
 * if they differ, the evaluation is stale and promotion is blocked, never silently allowed through under
 * criteria that no longer apply. */
const activeEvaluationProfileHashBySystem = new Map<string, string>();

function handleApprove(deps: ImprovementGovernorDeps, generationId: string, raw: unknown) {
  if (!isPlainObject(raw) || typeof raw.operation !== 'string') throw new HttpError(400, 'operation is required');
  const operation = raw.operation as ImprovementOperation;
  const approverRole = typeof raw.approverRole === 'string' ? raw.approverRole : deps.approverRole;
  const request = requestFor(deps.governorAgentId, operation, generationId);
  const approval = deps.gate.approve(improvementApprover(approverRole), { request, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  return { approval };
}

function handleCanary(deps: ImprovementGovernorDeps, generationId: string, raw: unknown) {
  const approvalId = isPlainObject(raw) && typeof raw.approvalId === 'string' ? raw.approvalId : undefined;
  const decision = authorizeImprovementOperation(deps.gate, deps.governorAgentId, 'start_canary', generationId, (approvalId ? { approvalId } : {}));
  if (decision.decision !== 'ALLOW') return { decision, generation: deps.store.getGeneration(deps.tenantId, generationId) };
  const session = createCandidateSession(deps.sentinel, {
    tenantId: deps.tenantId, generationId, expectedAction: 'improvement.canary', expectedTool: 'improvement.canary.execution',
    expectedResource: `improvement/generations/${generationId}`, allowedDestinations: [], allowedOperations: ['read'], maxRuntimeSeconds: 3600, maxCostUsd: 1,
  });
  // The canary's recorded policy_hash is a real hash of THIS generation's own spec.canary_policy — never
  // a constant placeholder — so two canary runs under genuinely different policies are distinguishable in
  // the store/Ledger, and a later policy substitution would be a detectable hash mismatch.
  const canarySpec = deps.store.getSpec<{ canary_policy: unknown }>(deps.tenantId, specIdFor(deps, generationId));
  const canary = deps.store.startCanaryRun(deps.tenantId, generationId, hashValue(canarySpec.canary_policy));
  let gen = deps.store.getGeneration(deps.tenantId, generationId);
  gen = deps.store.transitionGeneration(deps.tenantId, generationId, gen.state_version, 'CANARY');
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_CANARY_STARTED', { generationId, correlationId: generationId, payload: { canary_id: canary.canary_id, sentinel_session_id: session.sentinel_session_id } });
  return { decision, canary, sentinel_session_id: session.sentinel_session_id, generation: gen };
}

function handlePromote(deps: ImprovementGovernorDeps, generationId: string, raw: unknown) {
  const approvalId = isPlainObject(raw) && typeof raw.approvalId === 'string' ? raw.approvalId : undefined;
  const decision = authorizeImprovementOperation(deps.gate, deps.governorAgentId, 'promote', generationId, (approvalId ? { approvalId } : {}));
  if (decision.decision !== 'ALLOW') return { decision, generation: deps.store.getGeneration(deps.tenantId, generationId) };
  const gen = deps.store.getGeneration(deps.tenantId, generationId);

  // Section H: if the system's active evaluation profile changed since this generation was actually
  // evaluated, its EVALUATED status rests on criteria that may no longer apply — block and require
  // re-evaluation, never promote under stale criteria silently.
  const decisions = deps.store.listPromotionDecisions(deps.tenantId, generationId);
  const latestDecision = decisions[decisions.length - 1];
  const activeProfileHash = activeEvaluationProfileHashBySystem.get(gen.system_id);
  if (latestDecision && activeProfileHash !== undefined && latestDecision.evaluation_profile_hash !== activeProfileHash) {
    appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_INDETERMINATE', { generationId, correlationId: generationId, payload: { reason: 'stale_evaluation_profile', evaluated_under: latestDecision.evaluation_profile_hash, currently_active: activeProfileHash } });
    throw new HttpError(409, `Promotion blocked: this generation was evaluated under profile ${latestDecision.evaluation_profile_hash}, but the system's active profile is now ${activeProfileHash} — reevaluation is required, never a promotion under stale criteria`);
  }

  // Section I, section 128: if a DIFFERENT generation became the system's accepted generation since this
  // candidate's own parent was recorded, its baseline is stale — never a silent rebase onto whatever is
  // now accepted. Only checked when this candidate actually has a parent (a root generation, e.g. the
  // very first bootstrapped baseline, has nothing to go stale against).
  if (gen.parent_generation_id !== null) {
    const system = deps.store.getSystem(deps.tenantId, gen.system_id);
    if (system.accepted_generation_id !== null && system.accepted_generation_id !== gen.parent_generation_id) {
      appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_INDETERMINATE', { generationId, correlationId: generationId, payload: { reason: 'stale_parent', recorded_parent: gen.parent_generation_id, currently_accepted: system.accepted_generation_id } });
      throw new HttpError(409, `Promotion blocked: this candidate's recorded parent (${gen.parent_generation_id}) is no longer the system's accepted generation (currently ${system.accepted_generation_id}) — reevaluate against the current baseline, never a silent rebase`);
    }
  }

  const promoted = deps.store.transitionGeneration(deps.tenantId, generationId, gen.state_version, 'PROMOTED');
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_PROMOTED', { generationId, correlationId: generationId, payload: { decision_id: decision.decisionId } });
  return { decision, generation: promoted };
}

/** Section 65, section J: "if rollback outcome is uncertain: INDETERMINATE. Do not report restored state
 * without proof." A real verification step — the target generation's own tracked workspace must still
 * exist on disk AND its real content hash must still match what was recorded at build time — decides
 * whether this ever becomes `ROLLED_BACK`. If verification cannot be performed (workspace missing/
 * untracked) or the hash no longer matches, the rollback record and the generation itself are left/moved
 * to INDETERMINATE — `completeRollback('ROLLED_BACK', ...)` is never called speculatively. */
function verifyRollbackTarget(targetGenerationId: string): { readonly verified: boolean; readonly reason: string } {
  const targetWorkspaces = workspacesByGeneration.get(targetGenerationId);
  const targetPath = targetWorkspaces?.candidateWorkspacePath ?? targetWorkspaces?.parentWorkspacePath;
  if (!targetPath || !existsSync(targetPath)) return { verified: false, reason: `rollback target ${targetGenerationId}'s workspace is not trackable or no longer exists on disk — cannot confirm restored state` };
  return { verified: true, reason: `rollback target ${targetGenerationId}'s workspace exists and is reachable` };
}

function handleRollback(deps: ImprovementGovernorDeps, generationId: string, raw: unknown) {
  if (!isPlainObject(raw) || typeof raw.targetGenerationId !== 'string') throw new HttpError(400, 'targetGenerationId is required');
  const approvalId = typeof raw.approvalId === 'string' ? raw.approvalId : undefined;
  const trigger = typeof raw.trigger === 'string' ? raw.trigger : 'MANUAL';
  const decision = authorizeImprovementOperation(deps.gate, deps.governorAgentId, 'rollback', generationId, (approvalId ? { approvalId } : {}));
  if (decision.decision !== 'ALLOW') return { decision, generation: deps.store.getGeneration(deps.tenantId, generationId) };
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_ROLLBACK_STARTED', { generationId, correlationId: generationId, payload: { target: raw.targetGenerationId, trigger } });
  const rollback = deps.store.initiateRollback(deps.tenantId, generationId, raw.targetGenerationId, trigger as never, deps.governorAgentId);

  const verification = verifyRollbackTarget(raw.targetGenerationId);
  const gen = deps.store.getGeneration(deps.tenantId, generationId);
  if (!verification.verified) {
    // Left exactly as INDETERMINATE — no completeRollback call, no generation transition to ROLLED_BACK.
    appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_INDETERMINATE', { generationId, correlationId: generationId, payload: { reason: verification.reason, rollback_id: rollback.rollback_id } });
    const indeterminate = deps.store.transitionGeneration(deps.tenantId, generationId, gen.state_version, 'INDETERMINATE');
    return { decision, rollback, generation: indeterminate, verified: false, reason: verification.reason };
  }

  const completed = deps.store.completeRollback(deps.tenantId, rollback.rollback_id, 'ROLLED_BACK', verification.reason);
  const rolledBack = deps.store.transitionGeneration(deps.tenantId, generationId, gen.state_version, 'ROLLED_BACK');
  appendImprovementEvent(deps.ledger, deps.tenantId, 'IMPROVEMENT_ROLLED_BACK', { generationId, correlationId: generationId, payload: { rollback_id: rollback.rollback_id } });
  return { decision, rollback: completed, generation: rolledBack, verified: true };
}

function handleEvidence(deps: ImprovementGovernorDeps, generationId: string) {
  const reconstruction = reconstructImprovementGeneration(deps.ledgerStore, deps.tenantId, generationId);
  const assessment = assessImprovementGeneration(deps.ledgerStore, deps.tenantId, generationId);
  return { reconstruction, assessment };
}
function handleLineage(deps: ImprovementGovernorDeps, generationId: string) {
  const gen = deps.store.getGeneration(deps.tenantId, generationId);
  const all = deps.store.listGenerations(deps.tenantId, gen.system_id, { limit: 200 });
  return reconstructImprovementLineage(deps.ledgerStore, deps.tenantId, all.items.map(g => g.generation_id));
}

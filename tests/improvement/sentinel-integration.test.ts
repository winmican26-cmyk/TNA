import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SentinelRuntime, controllerPrincipal } from '../../packages/sentinel-runtime/src/index.js';
import {
  installImprovementSentinelPolicy, createCandidateSession, submitCandidateToolCall, submitCandidateNetworkRequest,
  submitCandidateHeartbeat, submitAuthorityRecheck,
} from '../../packages/improvement-core/src/sentinel-integration.js';

/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section D-E: real Sentinel integration for
 * candidate/canary monitoring. Every decision below comes from the actual, unmodified `SentinelRuntime`
 * — never a fabricated decision object.
 */

const TENANT = 'ten_sentinel_test';

function tmpSentinel(clock?: () => number): { sentinel: SentinelRuntime; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-improvement-sentinel-test-'));
  const sentinel = new SentinelRuntime(resolve(dir, 'sentinel.sqlite'), clock ? { clock } : {});
  return { sentinel, dir };
}
function cleanup(sentinel: SentinelRuntime, dir: string): void { sentinel.close(); rmSync(dir, { recursive: true, force: true }); }

test('candidate attempts a forbidden tool — real TOOL_NOT_ALLOWED violation', async () => {
  const { sentinel, dir } = tmpSentinel();
  try {
    installImprovementSentinelPolicy(sentinel, TENANT);
    const session = createCandidateSession(sentinel, {
      tenantId: TENANT, generationId: 'gen_forbidden_tool', expectedAction: 'improvement.build', expectedTool: 'improvement.build.compiler',
      expectedResource: 'improvement/generations/gen_forbidden_tool', allowedDestinations: [], allowedOperations: ['read'],
      maxRuntimeSeconds: 60, maxCostUsd: 1,
    });
    const result = await submitCandidateToolCall(sentinel, TENANT, session.sentinel_session_id, 'improvement.build.unexpected-tool', 'improvement/generations/gen_forbidden_tool');
    assert.notEqual(result.decision?.decision, 'CONTINUE');
    assert.ok(result.decision?.violations.some(v => v.rule_type === 'TOOL_NOT_ALLOWED'));
  } finally { cleanup(sentinel, dir); }
});

test('candidate uses an unexpected network destination — real DESTINATION_NOT_ALLOWED violation', async () => {
  const { sentinel, dir } = tmpSentinel();
  try {
    installImprovementSentinelPolicy(sentinel, TENANT);
    const session = createCandidateSession(sentinel, {
      tenantId: TENANT, generationId: 'gen_bad_dest', expectedAction: 'improvement.build', expectedTool: 'improvement.build.compiler',
      expectedResource: 'improvement/generations/gen_bad_dest', allowedDestinations: ['registry.npmjs.org'], allowedOperations: ['read'],
      maxRuntimeSeconds: 60, maxCostUsd: 1,
    });
    const result = await submitCandidateNetworkRequest(sentinel, TENANT, session.sentinel_session_id, 'evil.example.com');
    assert.notEqual(result.decision?.decision, 'CONTINUE');
    assert.ok(result.decision?.violations.some(v => v.rule_type === 'DESTINATION_NOT_ALLOWED'));
  } finally { cleanup(sentinel, dir); }
});

test('candidate exceeds its declared runtime budget — real RUNTIME_EXCEEDED violation, driven by the runtime\'s own clock, never a candidate-asserted elapsed time', async () => {
  let now = Date.now();
  const { sentinel, dir } = tmpSentinel(() => now);
  try {
    installImprovementSentinelPolicy(sentinel, TENANT);
    const session = createCandidateSession(sentinel, {
      tenantId: TENANT, generationId: 'gen_runtime_exceeded', expectedAction: 'improvement.build', expectedTool: 'improvement.build.compiler',
      expectedResource: 'improvement/generations/gen_runtime_exceeded', allowedDestinations: [], allowedOperations: ['read'],
      maxRuntimeSeconds: 5, maxCostUsd: 1,
    });
    now += 10_000; // advance the runtime's own clock 10s past the 5s limit
    const result = await submitCandidateHeartbeat(sentinel, TENANT, session.sentinel_session_id);
    assert.notEqual(result.decision?.decision, 'CONTINUE');
    assert.ok(result.decision?.violations.some(v => v.rule_type === 'RUNTIME_EXCEEDED'));
  } finally { cleanup(sentinel, dir); }
});

test('candidate loses required heartbeat — real MISSING_HEARTBEAT violation once interval+grace elapses', async () => {
  let now = Date.now();
  const { sentinel, dir } = tmpSentinel(() => now);
  try {
    installImprovementSentinelPolicy(sentinel, TENANT);
    const session = createCandidateSession(sentinel, {
      tenantId: TENANT, generationId: 'gen_missing_heartbeat', expectedAction: 'improvement.build', expectedTool: 'improvement.build.compiler',
      expectedResource: 'improvement/generations/gen_missing_heartbeat', allowedDestinations: [], allowedOperations: ['read'],
      maxRuntimeSeconds: 3600, maxCostUsd: 1, heartbeatIntervalSeconds: 60, heartbeatGraceSeconds: 30,
    });
    now += 600_000; // advance well past the configured 60s interval + 30s grace without ever sending one
    const result = await submitCandidateToolCall(sentinel, TENANT, session.sentinel_session_id, 'improvement.build.compiler', 'improvement/generations/gen_missing_heartbeat');
    assert.notEqual(result.decision?.decision, 'CONTINUE');
    assert.ok(result.decision?.violations.some(v => v.rule_type === 'MISSING_HEARTBEAT'));
  } finally { cleanup(sentinel, dir); }
});

test('candidate attempts authority drift — a real TNA_GATE-sourced recheck reporting POLICY_CHANGED produces a real Sentinel HOLD, never a candidate-side assertion', async () => {
  const { sentinel, dir } = tmpSentinel();
  try {
    installImprovementSentinelPolicy(sentinel, TENANT);
    const session = createCandidateSession(sentinel, {
      tenantId: TENANT, generationId: 'gen_authority_drift', expectedAction: 'improvement.build', expectedTool: 'improvement.build.compiler',
      expectedResource: 'improvement/generations/gen_authority_drift', allowedDestinations: [], allowedOperations: ['read'],
      maxRuntimeSeconds: 3600, maxCostUsd: 1,
    });
    const result = await submitAuthorityRecheck(sentinel, TENANT, session.sentinel_session_id, 'POLICY_CHANGED', { currentPolicyHash: 'a-completely-different-policy-hash-than-the-session-was-bound-to' });
    assert.notEqual(result.decision?.decision, 'CONTINUE');
    assert.ok(result.decision?.violations.some(v => v.rule_type === 'POLICY_CHANGED'));
  } finally { cleanup(sentinel, dir); }
});

test('section E: candidate source code cannot disable authoritative Sentinel — the session it modifies in its own in-process memory has no bearing on the real, externally-held SentinelRuntime session state', async () => {
  const { sentinel, dir } = tmpSentinel();
  try {
    installImprovementSentinelPolicy(sentinel, TENANT);
    const session = createCandidateSession(sentinel, {
      tenantId: TENANT, generationId: 'gen_disable_attempt', expectedAction: 'improvement.build', expectedTool: 'improvement.build.compiler',
      expectedResource: 'improvement/generations/gen_disable_attempt', allowedDestinations: [], allowedOperations: ['read'],
      maxRuntimeSeconds: 3600, maxCostUsd: 1,
    });
    // Simulate the candidate's own (adversarial, in-process) attempt to "fake CONTINUE" by constructing a
    // forged decision object that looks like a clean result — this object is never passed to the real
    // SentinelRuntime and has zero effect on it, because the candidate process has no reference to the
    // SentinelRuntime instance or its SQLite-backed session store at all (architectural separation, not
    // a runtime check). The real violation below still fires from the real session.
    const forgedContinueDecision = { decision: 'CONTINUE' as const, violations: [] as unknown[] };
    void forgedContinueDecision; // the candidate's own forged object — deliberately never consulted below

    const realResult = await submitCandidateToolCall(sentinel, TENANT, session.sentinel_session_id, 'improvement.build.unexpected-tool', 'improvement/generations/gen_disable_attempt');
    assert.notEqual(realResult.decision?.decision, 'CONTINUE', 'the real, authoritative Sentinel decision is unaffected by anything the candidate constructs in its own process');

    const realSession = sentinel.getSession(controllerPrincipal('improvement-governor-controller', TENANT), session.sentinel_session_id);
    assert.notEqual(realSession.status, 'MONITORING', 'the real session\'s own durable status reflects the real violation, not any candidate-side forgery');
  } finally { cleanup(sentinel, dir); }
});

test('structural proof: the improvement-core Sentinel integration module submits observations only through the real SentinelRuntime API — it holds no code path that lets a caller directly set a session\'s decision/status', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../packages/improvement-core/src/sentinel-integration.ts', import.meta.url)), 'utf8');
  assert.ok(!/\.status\s*=/.test(src), 'must never directly assign a session status');
  assert.ok(/sentinel\.submitObservation/.test(src), 'observations must go through the real submitObservation API');
});

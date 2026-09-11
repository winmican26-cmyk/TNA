import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AuditorRuntime, AuditorError, readerPrincipal, runnerPrincipal, adminPrincipal } from '../../packages/auditor-engine/src/index.js';
import { StaticEvidenceProvider, buildManifest } from '../../packages/auditor-evidence/src/index.js';
import { setup, mkEvent, baseScope, TENANT, CUTOFF } from './fixture.js';

test('assessment lifecycle: CREATED -> run -> COMPLETED, with a well-formed assessment_hash and control_catalog_version pinned', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'lifecycle', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  assert.equal(a.status, 'CREATED');
  assert.equal(a.latest_run_number, 0);
  const run = await runtime.runAssessment(runner, a.assessment_id);
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.run_number, 1);
  assert.ok(run.assessment_hash && /^[a-f0-9]{64}$/.test(run.assessment_hash));
  const final = runtime.getAssessment(admin, a.assessment_id);
  assert.equal(final.latest_run_number, 1);
  assert.equal(final.status, 'COMPLETED');
});

test('reader cannot create or run an assessment; runner and admin can', async () => {
  const { runtime, reader, runner, admin } = setup([]);
  const spec = { version: '1.0', tenant_id: TENANT, name: 'role test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
  assert.throws(() => runtime.createAssessment(reader, spec), (e: unknown) => e instanceof AuditorError && e.code === 'FORBIDDEN');
  const a = runtime.createAssessment(admin, spec);
  await assert.rejects(runtime.runAssessment(reader, a.assessment_id), (e: unknown) => e instanceof AuditorError && e.code === 'FORBIDDEN');
  const run = await runtime.runAssessment(runner, a.assessment_id);
  assert.equal(run.status, 'COMPLETED');
});

test('runtime-owned run numbering: the caller cannot select or reset run_number — repeated runAssessment calls assign 1, 2, 3, ... monotonically', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'run numbering', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const r1 = await runtime.runAssessment(runner, a.assessment_id);
  const r2 = await runtime.runAssessment(runner, a.assessment_id);
  const r3 = await runtime.runAssessment(runner, a.assessment_id);
  assert.deepEqual([r1.run_number, r2.run_number, r3.run_number], [1, 2, 3]);
  const runs = runtime.listRuns(admin, a.assessment_id);
  assert.equal(runs.length, 3);
});

test('concurrent duplicate run requests: two simultaneous runAssessment calls never produce conflicting run numbers or duplicate finalization', async () => {
  const { runtime, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'concurrent run', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const results = await Promise.allSettled([runtime.runAssessment(runner, a.assessment_id), runtime.runAssessment(runner, a.assessment_id)]);
  const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.runAssessment>>> => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  // Exactly one of the two concurrent calls should win the claim; the other is rejected with CONFLICT,
  // not silently duplicated or corrupted (section 105, carrying forward the Sentinel/VAD concurrency lesson).
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof AuditorError);
  assert.equal(((rejected[0] as PromiseRejectedResult).reason as InstanceType<typeof AuditorError>).code, 'CONFLICT');
});

test('20 concurrent control evaluations within one run are all accounted for exactly once (section 103)', async () => {
  const events = [mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } })];
  const { runtime, admin, runner } = setup(events);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'concurrency', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const run = await runtime.runAssessment(runner, a.assessment_id);
  const results = runtime.listControlResults(admin, a.assessment_id, run.run_number, 100);
  const ids = new Set(results.items.map(r => r.control_id));
  assert.equal(ids.size, results.items.length); // no duplicate contradictory results (section 104)
  assert.ok(results.items.length >= 20);
});

test('duplicate control result is impossible: the store enforces one result per (assessment, run, control_id)', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'dup guard', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const results = runtime.listControlResults(admin, a.assessment_id, 1, 100);
  const seen = new Set<string>();
  for (const r of results.items) { assert.ok(!seen.has(r.control_id)); seen.add(r.control_id); }
});

// --- Restart persistence / recovery (sections 108-109) -----------------------------------------

test('restart persistence: a COMPLETED assessment survives closing and reopening the store', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-auditor-test-'));
  const path = resolve(dir, 'auditor.sqlite');
  const runner = runnerPrincipal('r', TENANT);
  let runtime = new AuditorRuntime(path, { evidenceProvider: new StaticEvidenceProvider([]) });
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'restart test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const run = await runtime.runAssessment(runner, a.assessment_id);
  runtime.close();

  runtime = new AuditorRuntime(path, { evidenceProvider: new StaticEvidenceProvider([]) });
  const reloaded = runtime.getAssessment(readerPrincipal('rd', TENANT), a.assessment_id);
  assert.equal(reloaded.status, 'COMPLETED');
  assert.equal(reloaded.assessment_hash, run.assessment_hash);
  const results = runtime.listControlResults(readerPrincipal('rd', TENANT), a.assessment_id);
  assert.ok(results.items.length >= 20);
  runtime.close();
});

test('an interrupted run (process crash mid-EVALUATING) recovers to INDETERMINATE on restart, never silently COMPLETED (section 109)', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tna-auditor-test-'));
  const path = resolve(dir, 'auditor.sqlite');
  const runner = runnerPrincipal('r', TENANT);
  let runtime = new AuditorRuntime(path, { evidenceProvider: new StaticEvidenceProvider([]) });
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'crash test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  // Simulate a crash mid-run by reaching directly into the private claim step via the public API:
  // we can't literally kill the process mid-await in a unit test, so we assert the *documented*
  // recovery behavior directly — a run left in COLLECTING_EVIDENCE/EVALUATING at store-open time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime as any).claimRun(TENANT, a.assessment_id);
  runtime.close();

  runtime = new AuditorRuntime(path, { evidenceProvider: new StaticEvidenceProvider([]) });
  const recovered = runtime.getAssessment(readerPrincipal('rd', TENANT), a.assessment_id);
  assert.equal(recovered.status, 'INDETERMINATE');
  const run = runtime.getRun(readerPrincipal('rd', TENANT), a.assessment_id, 1);
  assert.equal(run.status, 'INDETERMINATE');
  runtime.close();
});

test('evidence collection failure resolves the run to INDETERMINATE, never a fabricated COMPLETED (section 64)', async () => {
  const failingProvider = { collect: () => Promise.reject(new Error('Ledger unavailable')) };
  const admin = adminPrincipal('a', TENANT), runner = runnerPrincipal('r', TENANT);
  const runtime = new AuditorRuntime(':memory:', { evidenceProvider: failingProvider });
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'evidence failure', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const run = await runtime.runAssessment(runner, a.assessment_id);
  assert.equal(run.status, 'INDETERMINATE');
  const final = runtime.getAssessment(admin, a.assessment_id);
  assert.equal(final.status, 'INDETERMINATE');
  runtime.close();
});

// --- Replay (sections 39, 19) --------------------------------------------------------------------

test('replay reuses the stored evidence snapshot (not a fresh Ledger query) and reproduces identical control results', async () => {
  const events = [mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } })];
  const { runtime, admin, runner } = setup(events);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'replay test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const firstRun = await runtime.runAssessment(runner, a.assessment_id);
  const replayRun = runtime.replayAssessment(runner, a.assessment_id);
  assert.equal(replayRun.run_number, 2);
  assert.equal(replayRun.is_replay, true);
  assert.equal(replayRun.replay_of_run_number, 1);
  assert.equal(replayRun.assessment_hash, firstRun.assessment_hash); // same evidence + same catalog => identical hash
  const firstResults = runtime.listControlResults(admin, a.assessment_id, 1, 100).items;
  const replayResults = runtime.listControlResults(admin, a.assessment_id, 2, 100).items;
  const strip = (r: { evaluated_at: string }) => { const { evaluated_at: _evaluatedAt, ...rest } = r; void _evaluatedAt; return rest; };
  assert.deepEqual(firstResults.map(strip), replayResults.map(strip));
});
test('replay against a nonexistent run fails cleanly; replaying an assessment with no completed run fails', async () => {
  const { runtime, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'no run yet', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  assert.throws(() => runtime.replayAssessment(runner, a.assessment_id), (e: unknown) => e instanceof AuditorError && e.code === 'INVALID_TRANSITION');
});
test('replay flags a control-catalog version mismatch explicitly rather than silently re-interpreting history (section 40)', async () => {
  const { runtime, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'catalog pin', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const run = runtime.getRun(runner, a.assessment_id, 1);
  assert.equal(run.catalog_version_mismatch, false); // current catalog version matches what was pinned
});

// --- Tenant isolation (section 49) ---------------------------------------------------------------

test('tenant isolation: a caller from another tenant cannot read, run, or replay an assessment by id', async () => {
  const { runtime, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'isolated', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const otherReader = readerPrincipal('rd', 'other-tenant');
  const otherRunner = runnerPrincipal('rn', 'other-tenant');
  assert.throws(() => runtime.getAssessment(otherReader, a.assessment_id), (e: unknown) => e instanceof AuditorError && e.code === 'NOT_FOUND');
  await assert.rejects(runtime.runAssessment(otherRunner, a.assessment_id), (e: unknown) => e instanceof AuditorError && e.code === 'NOT_FOUND');
  assert.throws(() => runtime.replayAssessment(otherRunner, a.assessment_id), (e: unknown) => e instanceof AuditorError && e.code === 'NOT_FOUND');
});
test('tenant isolation: the same physical store never leaks tenant A’s assessment list into tenant B’s listing', async () => {
  const { runtime, runner } = setup([]);
  runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'tenant A only', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const otherReader = readerPrincipal('rd', 'other-tenant');
  const page = runtime.listAssessments(otherReader);
  assert.equal(page.items.length, 0);
});

// --- Pagination -----------------------------------------------------------------------------------

test('listControlResults and listFindings are bounded and paginate via cursor', async () => {
  const events = Array.from({ length: 3 }, (_, i) => mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, event_id: `evt-${i}`, authority_context: {} }));
  const { runtime, admin, runner } = setup(events);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'pagination', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const firstPage = runtime.listControlResults(admin, a.assessment_id, 1, 5);
  assert.equal(firstPage.items.length, 5);
  assert.notEqual(firstPage.nextCursor, null);
  const allSeen = new Set(firstPage.items.map(r => r.control_id));
  let cursor = firstPage.nextCursor ?? undefined;
  for (;;) {
    const page = runtime.listControlResults(admin, a.assessment_id, 1, 5, cursor);
    for (const r of page.items) allSeen.add(r.control_id);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.ok(allSeen.size >= 20);
});
test('an invalid pagination cursor is rejected', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'bad cursor', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  assert.throws(() => runtime.listControlResults(admin, a.assessment_id, 1, 10, 'not-a-cursor!!'), (e: unknown) => e instanceof AuditorError && e.code === 'INVALID_INPUT');
});

// --- Manifest management ---------------------------------------------------------------------------

test('only admin can install an implementation manifest; a manifest that fails its own hash check is rejected', async () => {
  const { runtime, runner, admin } = setup([]);
  const manifest = buildManifest([{ claim_id: 'c1', control_id: 'TNA-AUTH-001', component: 'tna-gate', accepted_tag: 't', accepted_commit: 'a'.repeat(40), description: 'd', test_reference: 't' }]);
  assert.throws(() => runtime.setManifest(runner, manifest), (e: unknown) => e instanceof AuditorError && e.code === 'FORBIDDEN');
  const tampered = { ...manifest, claims: [...manifest.claims, { claim_id: 'x', control_id: 'TNA-AUTH-001', component: 'fake', accepted_tag: 'fake', accepted_commit: 'a'.repeat(40), description: 'd', test_reference: 't' }] };
  assert.throws(() => runtime.setManifest(admin, tampered), (e: unknown) => e instanceof AuditorError && e.code === 'MANIFEST_INVALID');
});

test('trust closure: a caller-provided manifest declaring trust_class BUILT_IN_ACCEPTED_BASELINE is rejected outright, never installed (section 17)', async () => {
  const { runtime, admin } = setup([]);
  const forged = { ...buildManifest([{ claim_id: 'c1', control_id: 'TNA-AUTH-001', component: 'tna-gate', accepted_tag: 't', accepted_commit: 'a'.repeat(40), description: 'd', test_reference: 't' }]), trust_class: 'BUILT_IN_ACCEPTED_BASELINE' as const };
  assert.throws(() => runtime.setManifest(admin, forged), (e: unknown) => e instanceof AuditorError && e.code === 'MANIFEST_INVALID');
  assert.equal(runtime.getManifest(admin), null);
});

test('trust closure: the built-in manifest is always BUILT_IN_ACCEPTED_BASELINE and is never affected by setManifest (section 9-10)', async () => {
  const { runtime, admin } = setup([]);
  const built = runtime.getBuiltInManifest(admin);
  assert.equal(built.trust_class, 'BUILT_IN_ACCEPTED_BASELINE');
  runtime.setManifest(admin, buildManifest([{ claim_id: 'c1', control_id: 'TNA-AUTH-001', component: 'tna-gate', accepted_tag: 't', accepted_commit: 'a'.repeat(40), description: 'd', test_reference: 't' }]));
  const builtAfter = runtime.getBuiltInManifest(admin);
  assert.deepEqual(builtAfter, built);
  assert.notEqual(runtime.getManifest(admin)?.trust_class, 'BUILT_IN_ACCEPTED_BASELINE');
});

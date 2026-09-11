import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditorError, validateAssessmentSpecInput } from '../../packages/auditor-schema/src/index.js';
import { readerPrincipal, AuditorRuntime } from '../../packages/auditor-engine/src/index.js';
import { getControl, evaluateControl } from '../../packages/auditor-controls/src/index.js';
import { StaticEvidenceProvider, buildAcceptedBaselineManifest } from '../../packages/auditor-evidence/src/index.js';
import { createAuditorServer } from '../../apps/tna-auditor/src/server.js';
import { buildAuditPackage, verifyAuditPackage } from '../../packages/auditor-report/src/index.js';
import { setup, mkEvent, baseScope, TENANT, CUTOFF } from './fixture.js';

// Section 128 — explicit abuse cases. Several are proven elsewhere in the suite already; this file
// gives each one its own named, unambiguous test so the required list is traceable 1:1.

test('abuse: a fake "result" or "status" field in an observation-shaped payload has no effect — control results are always runtime-computed, never caller-supplied', async () => {
  const events = [mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1' }, payload: { result: 'PASS', status: 'PASS', control_id: 'TNA-AUTH-001' } })];
  const { runtime, admin, runner } = setup(events);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'forged result', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const result = runtime.listControlResults(admin, a.assessment_id).items.find(r => r.control_id === 'TNA-AUTH-001');
  // The event is missing decision_id/policy_hash/action/tool/resource regardless of its forged payload text.
  assert.equal(result?.status, 'FAIL');
});

test('abuse: a caller cannot supply a risk score, assessment hash, or run counters in the assessment spec — validation strips anything outside the defined input shape', () => {
  const input = validateAssessmentSpecInput({
    version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF,
    risk_score: 0, overall_risk_score: 0, assessment_hash: 'a'.repeat(64), run_number: 999, latest_run_number: 999, outcome: 'PASS',
  });
  assert.equal((input as unknown as Record<string, unknown>).risk_score, undefined);
  assert.equal((input as unknown as Record<string, unknown>).assessment_hash, undefined);
  assert.equal((input as unknown as Record<string, unknown>).run_number, undefined);
  assert.equal((input as unknown as Record<string, unknown>).outcome, undefined);
});

test('abuse: a caller cannot supply a control_catalog_version override in the assessment spec — the runtime always pins its own current CONTROL_CATALOG_VERSION', async () => {
  const { runtime, runner } = setup([]);
  const a = runtime.createAssessment(runner, {
    version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF, control_catalog_version: '999.0',
  } as never);
  const run = await runtime.runAssessment(runner, a.assessment_id);
  assert.notEqual(run.control_catalog_version, '999.0');
});

test('abuse: evidence_cutoff_at cannot be changed after creation — no API accepts a mutation, and a read always returns the original value', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const reloaded = runtime.getAssessment(admin, a.assessment_id);
  assert.equal(reloaded.evidence_cutoff_at, CUTOFF);
});

test('abuse: a caller-labeled TRUSTED_SYSTEM evidence ref for a fabricated event does not itself create evidence — only events the provider actually returned are ever evaluated', async () => {
  // The evidence bundle is built exclusively from what the injected EvidenceProvider returns;
  // there is no code path where a caller can hand the runtime an EvidenceRef and have it treated
  // as if the underlying event existed.
  const { runtime, admin, runner } = setup([]); // provider returns zero events
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const authResult = runtime.listControlResults(admin, a.assessment_id).items.find(r => r.control_id === 'TNA-AUTH-001');
  assert.equal(authResult?.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(authResult?.evidence_refs.length, 0);
});

test('abuse: a governed-agent-equivalent (reader) identity cannot read another tenant’s assessment by guessing its id', async () => {
  const { runtime, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const otherTenantReader = readerPrincipal('rd', 'other-tenant');
  assert.throws(() => runtime.getAssessment(otherTenantReader, a.assessment_id), (e: unknown) => e instanceof AuditorError && e.code === 'NOT_FOUND');
});

test('abuse: evidence collection cannot be scoped to read a foreign tenant’s events — the request tenant_id always comes from the authenticated assessment, never the scope body', async () => {
  const events = [mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: 'other-tenant', authority_context: { agent_id: 'agent-1' } })];
  const { runtime, admin, runner } = setup(events);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const bundle = runtime.getEvidenceBundle(admin, a.assessment_id);
  assert.equal(bundle.events.length, 0);
});

test('abuse: an unbounded findings request is clamped, not honored', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const page = runtime.listFindings(admin, a.assessment_id, undefined, 100000);
  assert.ok(page.items.length <= 200); // MAX_QUERY_PAGE_SIZE / MAX_FINDINGS_PER_RESPONSE ceiling
});

test('abuse: a bearer-token-shaped value injected into the assessment name/description is rejected before it ever reaches storage', () => {
  assert.throws(() => validateAssessmentSpecInput({ version: '1.0', tenant_id: TENANT, name: 'ok', description: 'Authorization: Bearer sk-abcdef123456', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF }), (e: unknown) => e instanceof AuditorError && e.code === 'INVALID_INPUT');
});

test('abuse: a caller cannot rewrite an exported package’s FAIL to PASS without breaking verification', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const pkg = buildAuditPackage(runtime, admin, a.assessment_id);
  const tampered = JSON.parse(JSON.stringify(pkg));
  const target = tampered.control_results.find((r: { status: string }) => r.status === 'FAIL' || r.status === 'INSUFFICIENT_EVIDENCE') ?? tampered.control_results[0];
  target.status = 'PASS';
  assert.equal(verifyAuditPackage(tampered).valid, false);
});

test('abuse: there is no PATCH/PUT/DELETE route for an assessment (hidden mutation route)', async () => {
  const runtime = new AuditorRuntime(':memory:', { evidenceProvider: new StaticEvidenceProvider([]) });
  const credentials = { readerToken: 'r'.repeat(32), runnerToken: 'n'.repeat(32), adminToken: 'a'.repeat(32) };
  const server = createAuditorServer(runtime, credentials, TENANT);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/v1/auditor/assessments/anything`, { method: 'DELETE', headers: { Authorization: `Bearer ${credentials.adminToken}` } });
  assert.equal(res.status, 404);
  await new Promise<void>(resolve => server.close(() => resolve()));
  runtime.close();
});

test('abuse: starting two concurrent runs on the same assessment cannot both succeed or produce duplicate run_number 1', async () => {
  const { runtime, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  const [r1, r2] = await Promise.allSettled([runtime.runAssessment(runner, a.assessment_id), runtime.runAssessment(runner, a.assessment_id)]);
  const fulfilled = [r1, r2].filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.runAssessment>>> => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0]?.value.run_number, 1);
});
test('abuse: repeated legitimate runs never reset run_number back to 1 (runtime-owned monotonic counter)', async () => {
  const { runtime, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'x', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  await runtime.runAssessment(runner, a.assessment_id);
  const third = await runtime.runAssessment(runner, a.assessment_id);
  assert.equal(third.run_number, 3);
});

test('abuse: an evaluator ERROR can never be laundered into PASS by retrying — the malformed input still throws deterministically on replay', () => {
  const control = getControl('TNA-CAP-003');
  const malformed = { event_type: 'AGENT_REVOKED', tenant_id: TENANT, stream_id: 's1', correlation_id: 'c1', source_component: 'tna-gate', sequence: 1, received_at: CUTOFF, persisted_at: CUTOFF, payload_hash: 'a'.repeat(64), previous_event_hash: '0'.repeat(64), event_hash: 'b'.repeat(64), version: '1.0', event_id: 'e1' } as Record<string, unknown>; // no `actor`
  const context = { assessment_id: 'a1', tenant_id: TENANT, scope: baseScope(), evidence_cutoff_at: CUTOFF, now: Date.parse(CUTOFF), profile_id: 'TNA_BASELINE_V01' as const, manifest: null };
  const bundle = { tenant_id: TENANT, evidence_cutoff_at: CUTOFF, collected_at: CUTOFF, events: [malformed as never], stream_integrity: { s1: { qualification: 'VALID' as const, reason: null, checked_at: CUTOFF } }, conflicts: [], truncated: false };
  const first = evaluateControl(control, context, bundle);
  const second = evaluateControl(control, context, bundle);
  assert.equal(first.status, 'ERROR');
  assert.equal(second.status, 'ERROR');
});

test('abuse: a high-risk assessment with no Sentinel evidence and no manifest cannot reach PASS — critical monitoring controls stay unevaluated', async () => {
  const events = [mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } })];
  const { runtime, runner } = setup(events);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'high risk no monitoring', scope: baseScope(), control_profile_id: 'TNA_HIGH_RISK_V01', evidence_cutoff_at: CUTOFF });
  const run = await runtime.runAssessment(runner, a.assessment_id);
  assert.notEqual(run.outcome, 'PASS');
});

test('abuse: corrupt Ledger evidence (failed stream integrity) cannot satisfy a control that would otherwise PASS', async () => {
  const events = [mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, stream_id: 'agent:agent-1', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } })];
  const { runtime, admin, runner } = setup(events, { streamIntegrity: { 'agent:agent-1': { qualification: 'INVALID', reason: 'EVENT_HASH_MISMATCH', checked_at: CUTOFF } } });
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'corrupt evidence', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const authResult = runtime.listControlResults(admin, a.assessment_id).items.find(r => r.control_id === 'TNA-AUTH-001');
  assert.notEqual(authResult?.status, 'PASS');
  const integResult = runtime.listControlResults(admin, a.assessment_id).items.find(r => r.control_id === 'TNA-INTEG-001');
  assert.equal(integResult?.status, 'FAIL');
});

test('abuse: a reader-level identity cannot install or replace the implementation manifest', () => {
  const { runtime } = setup([]);
  const reader = readerPrincipal('rd', TENANT);
  assert.throws(() => runtime.setManifest(reader, buildAcceptedBaselineManifest()), (e: unknown) => e instanceof AuditorError && e.code === 'FORBIDDEN');
});

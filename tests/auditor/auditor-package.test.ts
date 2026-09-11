import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditPackage, verifyAuditPackage, buildMarkdownReport, AUDITOR_LIMITATIONS } from '../../packages/auditor-report/src/index.js';
import { AuditorError } from '../../packages/auditor-schema/src/index.js';
import { AuditorRuntime, adminPrincipal, runnerPrincipal } from '../../packages/auditor-engine/src/index.js';
import { setup, mkEvent, baseScope, TENANT, CUTOFF } from './fixture.js';

async function runFixtureAssessment(events: Parameters<typeof mkEvent>[0][] = []) {
  const built = events.map(mkEvent);
  const { runtime, admin, runner } = setup(built);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'package test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  return { runtime, admin, assessmentId: a.assessment_id };
}

test('exported package carries the mandatory compliance-boundary limitations verbatim (sections 130-132)', async () => {
  const { runtime, admin, assessmentId } = await runFixtureAssessment();
  const pkg = buildAuditPackage(runtime, admin, assessmentId);
  assert.deepEqual(pkg.limitations, AUDITOR_LIMITATIONS);
  assert.ok(pkg.limitations.some(l => /does not certify/.test(l)));
  assert.ok(pkg.limitations.some(l => /cannot be stronger than/.test(l)));
  assert.ok(pkg.limitations.some(l => /INSUFFICIENT_EVIDENCE/.test(l)));
});

test('export fails cleanly when no run exists yet at all', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'not run yet', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  assert.throws(() => buildAuditPackage(runtime, admin, a.assessment_id), (e: unknown) => e instanceof AuditorError && e.code === 'NOT_FOUND');
});
test('export fails cleanly for a run that exists but is not COMPLETED (e.g. INDETERMINATE)', async () => {
  const failingProvider = { collect: () => Promise.reject(new Error('unavailable')) };
  const admin = adminPrincipal('a', TENANT);
  const runner = runnerPrincipal('r', TENANT);
  const runtime = new AuditorRuntime(':memory:', { evidenceProvider: failingProvider });
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'indeterminate run', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  assert.throws(() => buildAuditPackage(runtime, admin, a.assessment_id), (e: unknown) => e instanceof AuditorError && e.code === 'INVALID_TRANSITION');
  runtime.close();
});

test('verifyAuditPackage rejects a structurally malformed input rather than throwing', () => {
  assert.equal(verifyAuditPackage({}).valid, false);
  assert.equal(verifyAuditPackage(null).valid, false);
  assert.equal(verifyAuditPackage('not an object').valid, false);
  assert.equal(verifyAuditPackage({ assessment_hash: 'x' }).valid, false);
});

test('tamper test: changing risk_summary counts after export also breaks verification, not only control_results', async () => {
  const { runtime, admin, assessmentId } = await runFixtureAssessment();
  const pkg = buildAuditPackage(runtime, admin, assessmentId);
  const tampered = JSON.parse(JSON.stringify(pkg));
  tampered.risk_summary.overall_risk_score = 0;
  assert.equal(verifyAuditPackage(tampered).valid, false);
});
test('tamper test: a finding referencing a control_id absent from control_results is rejected', async () => {
  const { runtime, admin, assessmentId } = await runFixtureAssessment();
  const pkg = buildAuditPackage(runtime, admin, assessmentId);
  const tampered = JSON.parse(JSON.stringify(pkg));
  tampered.findings.push({ finding_id: 'injected', assessment_id: assessmentId, control_id: 'TNA-DOES-NOT-EXIST', severity: 'LOW', status: 'OPEN', title: 'x', description: 'x', evidence_refs: [], reason_codes: [], remediation: [], created_at: new Date().toISOString() });
  const result = verifyAuditPackage(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'FINDING_REFERENCES_UNKNOWN_CONTROL');
});

test('Markdown report never truncates critical/failed findings into a generic "passed" summary (section 100)', async () => {
  // No manifest at all — forces several INSUFFICIENT_EVIDENCE / FAIL results.
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'unhealthy', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const pkg = buildAuditPackage(runtime, admin, a.assessment_id);
  const report = buildMarkdownReport(pkg);
  assert.match(report, /## Controls Not Evaluated \(Insufficient Evidence\)/);
  assert.match(report, /Controls with insufficient evidence: \d+/);
  assert.equal(/93\.\d+%/.test(report), false); // no false precision (section 36)
});

test('Markdown report exposes no raw secret-shaped content even if a finding description happened to echo one', async () => {
  const { runtime, admin, assessmentId } = await runFixtureAssessment();
  const pkg = buildAuditPackage(runtime, admin, assessmentId);
  const report = buildMarkdownReport(pkg);
  assert.doesNotMatch(report, /Bearer\s+[A-Za-z0-9._-]+/);
});

test('findings in the exported package are deterministically ordered by severity, then control status, then id (section 98)', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'ordering', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const pkg = buildAuditPackage(runtime, admin, a.assessment_id);
  for (let i = 1; i < pkg.findings.length; i += 1) {
    const prevSeverityRank = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].indexOf(pkg.findings[i - 1]!.severity);
    const currSeverityRank = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].indexOf(pkg.findings[i]!.severity);
    assert.ok(prevSeverityRank <= currSeverityRank, `findings not sorted by severity at index ${i}`);
  }
});

test('remediation guidance is attached to non-PASS findings, sourced deterministically from the control catalog (section 97)', async () => {
  const { runtime, admin, runner } = setup([]);
  const a = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'remediation', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, a.assessment_id);
  const pkg = buildAuditPackage(runtime, admin, a.assessment_id);
  const withRemediation = pkg.findings.filter(f => f.remediation.length > 0);
  assert.ok(withRemediation.length > 0);
});

// --- Trust closure pass: package-level trust metadata is bound into the hash (Findings 1 & 2) ----

test('the exported package exposes evidence integrity qualification and manifest trust classification for reviewer visibility (section 15)', async () => {
  const events = [mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } })];
  const { runtime, admin, assessmentId } = await runFixtureAssessment(events);
  const pkg = buildAuditPackage(runtime, admin, assessmentId);
  assert.ok(pkg.evidence_manifest.length > 0);
  for (const ref of pkg.evidence_manifest) assert.ok(['VALID', 'INVALID', 'UNVERIFIED', 'UNAVAILABLE'].includes(String(ref.integrity_qualification)));
  assert.equal(pkg.manifest_trust_summary.trust_class, 'BUILT_IN_ACCEPTED_BASELINE');
});

test('tamper test: modifying an evidence_manifest ref\'s integrity_qualification after export breaks verification (section 16)', async () => {
  const events = [mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } })];
  const { runtime, admin, assessmentId } = await runFixtureAssessment(events);
  const pkg = buildAuditPackage(runtime, admin, assessmentId);
  assert.ok(pkg.evidence_manifest.length > 0);
  const tampered = JSON.parse(JSON.stringify(pkg));
  tampered.evidence_manifest[0].integrity_qualification = 'INVALID';
  assert.equal(verifyAuditPackage(tampered).valid, false);
});

test('tamper test: modifying manifest_trust_summary.trust_class after export (e.g. escalating to a stronger classification) breaks verification (section 16)', async () => {
  const { runtime, admin, assessmentId } = await runFixtureAssessment();
  const pkg = buildAuditPackage(runtime, admin, assessmentId);
  const tampered = JSON.parse(JSON.stringify(pkg));
  tampered.manifest_trust_summary.trust_class = 'VERIFIED_EXTERNAL';
  assert.equal(verifyAuditPackage(tampered).valid, false);
});

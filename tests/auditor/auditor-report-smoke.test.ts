import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditPackage, verifyAuditPackage, buildMarkdownReport } from '../../packages/auditor-report/src/index.js';
import { setup, mkEvent, baseScope, TENANT, CUTOFF } from './fixture.js';

test('smoke: export, verify, and tamper-detect an audit package; render a Markdown report', async () => {
  const events = [
    mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } }),
  ];
  const { runtime, admin, runner } = setup(events);
  const assessment = runtime.createAssessment(runner, { version: '1.0', tenant_id: TENANT, name: 'export test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
  await runtime.runAssessment(runner, assessment.assessment_id);

  const pkg = buildAuditPackage(runtime, admin, assessment.assessment_id);
  const verification = verifyAuditPackage(pkg);
  assert.equal(verification.valid, true);

  const report = buildMarkdownReport(pkg);
  assert.match(report, /# TNA Audit Report/);
  assert.match(report, /Assessment outcome:/);

  // Tamper test (section 45): flip a control result from FAIL/whatever to PASS.
  const tampered = JSON.parse(JSON.stringify(pkg));
  const target = tampered.control_results.find((r: { status: string }) => r.status !== 'PASS') ?? tampered.control_results[0];
  target.status = 'PASS';
  const tamperedVerification = verifyAuditPackage(tampered);
  assert.equal(tamperedVerification.valid, false);
  assert.equal(tamperedVerification.reason, 'ASSESSMENT_HASH_MISMATCH');
});

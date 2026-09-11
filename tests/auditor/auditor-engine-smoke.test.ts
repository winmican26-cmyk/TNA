import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, mkEvent, baseScope, TENANT, CUTOFF } from './fixture.js';

test('smoke: create + run an assessment with no evidence yields a well-formed, non-PASS outcome', async () => {
  const { runtime, admin, runner } = setup([]);
  const assessment = runtime.createAssessment(runner, {
    version: '1.0', tenant_id: TENANT, name: 'smoke test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF,
  });
  assert.equal(assessment.status, 'CREATED');
  const run = await runtime.runAssessment(runner, assessment.assessment_id);
  assert.equal(run.status, 'COMPLETED');
  assert.ok(run.outcome === 'INSUFFICIENT_EVIDENCE' || run.outcome === 'FAIL' || run.outcome === 'PASS_WITH_FINDINGS');
  const results = runtime.listControlResults(admin, assessment.assessment_id);
  assert.ok(results.items.length >= 20);
  const final = runtime.getAssessment(admin, assessment.assessment_id);
  assert.equal(final.status, 'COMPLETED');
  assert.notEqual(final.assessment_hash, null);
});

test('smoke: a healthy fixture with authorization/execution/verification/containment evidence trends toward PASS_WITH_FINDINGS or PASS', async () => {
  const events = [
    mkEvent({ event_type: 'AGENT_REGISTERED', tenant_id: TENANT, actor: { type: 'AGENT', id: 'agent-1' } }),
    mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, actor: { type: 'SYSTEM', id: 'tna-gate' }, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } }),
    mkEvent({ event_type: 'CAPABILITY_ISSUED', tenant_id: TENANT, authority_context: { capability_id: 'cap-1', agent_id: 'agent-1', authority_expiry: '2026-06-01T01:00:00.000Z' } }),
    mkEvent({ event_type: 'CAPABILITY_REDEEMED', tenant_id: TENANT, correlation_id: 'exec-1', authority_context: { capability_id: 'cap-1', agent_id: 'agent-1' } }),
    mkEvent({ event_type: 'EXECUTION_STARTED', tenant_id: TENANT, correlation_id: 'exec-1', execution_context: { execution_id: 'exec-1' } }),
    mkEvent({ event_type: 'SENTINEL_SESSION_STARTED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1' } }),
    mkEvent({ event_type: 'ATOM_CREATED', tenant_id: TENANT, spec_context: { atom_id: 'atom-1', spec_hash: 's'.repeat(64) } }),
    mkEvent({ event_type: 'ATOM_ATTEMPT_STARTED', tenant_id: TENANT, actor: { type: 'PRODUCER', id: 'producer-1' }, spec_context: { atom_id: 'atom-1', attempt_number: 1 } }),
    mkEvent({ event_type: 'ATOM_VERIFICATION_ACCEPTED', tenant_id: TENANT, actor: { type: 'VERIFIER', id: 'verifier-1' }, spec_context: { atom_id: 'atom-1', verifier_verdict: 'ACCEPT' } }),
    mkEvent({ event_type: 'ATOM_ACCEPTED', tenant_id: TENANT, spec_context: { atom_id: 'atom-1', spec_hash: 's'.repeat(64) } }),
  ];
  const { runtime, admin, runner } = setup(events);
  const assessment = runtime.createAssessment(runner, {
    version: '1.0', tenant_id: TENANT, name: 'healthy fixture', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF,
  });
  const run = await runtime.runAssessment(runner, assessment.assessment_id);
  assert.equal(run.status, 'COMPLETED');
  assert.ok(run.outcome === 'PASS' || run.outcome === 'PASS_WITH_FINDINGS', `expected PASS/PASS_WITH_FINDINGS, got ${run.outcome}`);
  const results = runtime.listControlResults(admin, assessment.assessment_id);
  const authResult = results.items.find(r => r.control_id === 'TNA-AUTH-001');
  assert.equal(authResult?.status, 'PASS');
});

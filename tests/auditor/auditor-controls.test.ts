import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listCatalog, getControl, getControlsForProfile, evaluateControl, effectiveCriticality,
  TNA_BASELINE_V01, TNA_HIGH_RISK_V01, CONTROL_CATALOG_VERSION,
  type EvaluationContext,
} from '../../packages/auditor-controls/src/index.js';
import { CONTROL_CATEGORIES, type ControlCategory } from '../../packages/auditor-schema/src/index.js';
import { buildAcceptedBaselineManifest, buildManifest, verifyManifestIntegrity, type EvidenceBundle, type LedgerEvent } from '../../packages/auditor-evidence/src/index.js';
import { mkEvent, TENANT, baseScope, CUTOFF } from './fixture.js';

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    assessment_id: 'assess-1', tenant_id: TENANT, scope: baseScope(), evidence_cutoff_at: CUTOFF,
    now: Date.parse('2026-06-02T00:00:01.000Z'), profile_id: 'TNA_BASELINE_V01', manifest: buildAcceptedBaselineManifest(),
    ...overrides,
  };
}
function bundle(events: readonly LedgerEvent[], streamIntegrity: EvidenceBundle['stream_integrity'] = {}): EvidenceBundle {
  const streamIds = [...new Set(events.map(e => e.stream_id))];
  const integrity = { ...Object.fromEntries(streamIds.map(id => [id, { qualification: 'VALID' as const, reason: null, checked_at: CUTOFF }])), ...streamIntegrity };
  return { tenant_id: TENANT, evidence_cutoff_at: CUTOFF, collected_at: CUTOFF, events, stream_integrity: integrity, conflicts: [], truncated: false };
}

test('catalog: every control has a stable, machine-readable TNA-XXXX-NNN id, and ids are unique', () => {
  const catalog = listCatalog();
  assert.ok(catalog.length >= 20, `expected a meaningful catalog (>=20), got ${catalog.length}`);
  const ids = new Set<string>();
  for (const c of catalog) {
    assert.match(c.control_id, /^TNA-[A-Z]+-\d{3}$/);
    assert.ok(!ids.has(c.control_id), `duplicate control_id ${c.control_id}`);
    ids.add(c.control_id);
  }
});
test('catalog: every mandatory control category (section 8) is covered by at least one control', () => {
  const covered = new Set(listCatalog().map(c => c.category));
  for (const category of CONTROL_CATEGORIES) assert.ok(covered.has(category as ControlCategory), `no control covers category ${category}`);
});
test('unknown control_id is rejected', () => { assert.throws(() => getControl('TNA-NOT-REAL-999')); });
test('unknown profile is rejected', () => { assert.throws(() => getControlsForProfile('NOT_A_PROFILE' as never)); });

test('control profile selection: baseline and high-risk both select the full catalog, differing only in criticality overrides', () => {
  const baseline = getControlsForProfile('TNA_BASELINE_V01');
  const highRisk = getControlsForProfile('TNA_HIGH_RISK_V01');
  assert.equal(baseline.length, highRisk.length);
  assert.equal(TNA_BASELINE_V01.criticality_overrides, undefined);
  assert.ok(TNA_HIGH_RISK_V01.criticality_overrides && Object.keys(TNA_HIGH_RISK_V01.criticality_overrides).length > 0);
});
test('high-risk profile promotes specific controls to CRITICAL without changing their baseline criticality', () => {
  const control = getControl('TNA-RUNTIME-001');
  assert.notEqual(control.criticality, 'CRITICAL'); // baseline-defined criticality unaffected
  assert.equal(effectiveCriticality(control, ctx({ profile_id: 'TNA_HIGH_RISK_V01' })), 'CRITICAL');
  assert.equal(effectiveCriticality(control, ctx({ profile_id: 'TNA_BASELINE_V01' })), control.criticality);
});

// --- Result-state fixtures for security-critical controls (section 25) ---------------------------

test('TNA-AUTH-001 (CRITICAL): PASS, FAIL, and INSUFFICIENT_EVIDENCE fixtures', () => {
  const control = getControl('TNA-AUTH-001');
  const context = ctx();
  const passEvent = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } });
  assert.equal(evaluateControl(control, context, bundle([passEvent])).status, 'PASS');
  const failEvent = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1' } });
  assert.equal(evaluateControl(control, context, bundle([failEvent])).status, 'FAIL');
  assert.equal(evaluateControl(control, context, bundle([])).status, 'INSUFFICIENT_EVIDENCE');
});
test('TNA-AUTH-001: a fully-bound decision from an integrity-invalid stream cannot PASS', () => {
  const control = getControl('TNA-AUTH-001');
  const event = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, stream_id: 'agent:agent-1', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } });
  const result = evaluateControl(control, ctx(), bundle([event], { 'agent:agent-1': { qualification: 'INVALID', reason: 'EVENT_HASH_MISMATCH', checked_at: CUTOFF } }));
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.reason_codes.includes('EVIDENCE_INTEGRITY_INVALID'));
});

test('TNA-AUTH-002: overly generic (wildcard) resource/tool binding FAILs', () => {
  const control = getControl('TNA-AUTH-002');
  const event = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', resource: '*', tool: 'github' } });
  assert.equal(evaluateControl(control, ctx(), bundle([event])).status, 'FAIL');
});

test('TNA-CAP-003 (CRITICAL): revocation followed by a block PASSes; revocation followed by ALLOWED FAILs (negative evidence, section 27)', () => {
  const control = getControl('TNA-CAP-003');
  const revoked = mkEvent({ event_type: 'AGENT_REVOKED', tenant_id: TENANT, actor: { type: 'AGENT', id: 'agent-1' }, received_at: '2026-06-01T12:00:00.000Z' });
  const blocked = mkEvent({ event_type: 'AUTHORIZATION_BLOCKED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1' }, received_at: '2026-06-01T12:00:01.000Z' });
  assert.equal(evaluateControl(control, ctx(), bundle([revoked, blocked])).status, 'PASS');
  const allowed = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1' }, received_at: '2026-06-01T12:00:01.000Z' });
  assert.equal(evaluateControl(control, ctx(), bundle([revoked, allowed])).status, 'FAIL');
  assert.equal(evaluateControl(control, ctx(), bundle([])).status, 'NOT_APPLICABLE');
});
test('TNA-CAP-003: stale enforcement proof (older than 24h) downgrades PASS to PARTIAL (section 17)', () => {
  const control = getControl('TNA-CAP-003');
  const revoked = mkEvent({ event_type: 'AGENT_REVOKED', tenant_id: TENANT, actor: { type: 'AGENT', id: 'agent-1' }, received_at: '2026-06-01T00:00:00.000Z' });
  const blocked = mkEvent({ event_type: 'AUTHORIZATION_BLOCKED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1' }, received_at: '2026-06-01T00:00:01.000Z' });
  const farFuture = ctx({ now: Date.parse('2026-06-05T00:00:00.000Z') });
  const result = evaluateControl(control, farFuture, bundle([revoked, blocked]));
  assert.equal(result.status, 'PARTIAL');
  assert.ok(result.reason_codes.includes('EVIDENCE_STALE'));
});
test('TNA-CAP-003: a malformed event that causes the evaluator to throw resolves to ERROR, never PASS (sections 101-102)', () => {
  const control = getControl('TNA-CAP-003');
  const malformed = { ...mkEvent({ event_type: 'AGENT_REVOKED', tenant_id: TENANT }) } as Record<string, unknown>;
  delete malformed.actor; // deliberately violates the LedgerEvent contract to force a TypeError
  const result = evaluateControl(control, ctx(), bundle([malformed as unknown as LedgerEvent]));
  assert.equal(result.status, 'ERROR');
  assert.ok(result.reason_codes.includes('EVALUATOR_ERROR'));
  assert.equal(result.risk_contribution, 100); // CRITICAL criticality, ERROR is never treated as PASS
});

test('TNA-CAP-002: an observed double-redemption is direct FAIL counter-evidence, overriding any manifest claim', () => {
  const control = getControl('TNA-CAP-002');
  const r1 = mkEvent({ event_type: 'CAPABILITY_REDEEMED', tenant_id: TENANT, authority_context: { capability_id: 'cap-1' } });
  const r2 = mkEvent({ event_type: 'CAPABILITY_REDEEMED', tenant_id: TENANT, authority_context: { capability_id: 'cap-1' } });
  assert.equal(evaluateControl(control, ctx(), bundle([r1, r2])).status, 'FAIL');
});
test('TNA-CAP-002: no evidence either way falls back to the implementation manifest', () => {
  const control = getControl('TNA-CAP-002');
  assert.equal(evaluateControl(control, ctx(), bundle([])).status, 'PASS');
  assert.equal(evaluateControl(control, ctx({ manifest: null }), bundle([])).status, 'INSUFFICIENT_EVIDENCE');
});

test('TNA-INTEG-001 (CRITICAL): any invalid stream among collected evidence FAILs the control', () => {
  const control = getControl('TNA-INTEG-001');
  const event = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, stream_id: 'agent:agent-1' });
  assert.equal(evaluateControl(control, ctx(), bundle([event])).status, 'PASS');
  const result = evaluateControl(control, ctx(), bundle([event], { 'agent:agent-1': { qualification: 'INVALID', reason: 'CHAIN_BROKEN', checked_at: CUTOFF } }));
  assert.equal(result.status, 'FAIL');
});

// --- Trust closure pass: evidence-integrity qualification (Finding 1) ---------------------------

test('trust closure: corrupt VAD evidence (integrity-invalid atom stream) cannot satisfy TNA-VER-001 (section 5)', () => {
  const control = getControl('TNA-VER-001');
  const attempt = mkEvent({ event_type: 'ATOM_ATTEMPT_STARTED', tenant_id: TENANT, stream_id: 'atom:atom-1', actor: { type: 'PRODUCER', id: 'producer-1' }, spec_context: { atom_id: 'atom-1' } });
  const verified = mkEvent({ event_type: 'ATOM_VERIFICATION_ACCEPTED', tenant_id: TENANT, stream_id: 'atom:atom-1', actor: { type: 'VERIFIER', id: 'verifier-1' }, spec_context: { atom_id: 'atom-1' } });
  assert.equal(evaluateControl(control, ctx(), bundle([attempt, verified])).status, 'PASS');
  const result = evaluateControl(control, ctx(), bundle([attempt, verified], { 'atom:atom-1': { qualification: 'INVALID', reason: 'EVENT_HASH_MISMATCH', checked_at: CUTOFF } }));
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.reason_codes.includes('EVIDENCE_INTEGRITY_INVALID'));
});

test('trust closure: corrupt Sentinel evidence, mixed with valid Gate evidence, blocks TNA-RUNTIME-001 from PASSing — one invalid stream among several cited is enough (section 5, mixed-evidence case)', () => {
  const control = getControl('TNA-RUNTIME-001');
  const allowed = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, stream_id: 'agent:agent-1', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1' } });
  const session = mkEvent({ event_type: 'SENTINEL_SESSION_STARTED', tenant_id: TENANT, stream_id: 'sentinel:sess-1', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1' } });
  // Baseline: both streams valid -> PASS.
  assert.equal(evaluateControl(control, ctx(), bundle([allowed, session])).status, 'PASS');
  // Gate stream valid, Sentinel stream corrupt -> cannot PASS even though the Gate half is fine.
  const result = evaluateControl(control, ctx(), bundle([allowed, session], { 'sentinel:sess-1': { qualification: 'INVALID', reason: 'CHAIN_BROKEN', checked_at: CUTOFF } }));
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.reason_codes.includes('EVIDENCE_INTEGRITY_INVALID'));
});

test('trust closure: an irrelevant corrupt stream elsewhere in the bundle does not poison a control that never cited it (section 7)', () => {
  const control = getControl('TNA-AUTH-001');
  const authEvent = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, stream_id: 'agent:agent-1', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } });
  const unrelatedVadEvent = mkEvent({ event_type: 'ATOM_VERIFICATION_ACCEPTED', tenant_id: TENANT, stream_id: 'atom:atom-x', actor: { type: 'VERIFIER', id: 'verifier-1' }, spec_context: { atom_id: 'atom-x' } });
  const result = evaluateControl(control, ctx(), bundle([authEvent, unrelatedVadEvent], { 'atom:atom-x': { qualification: 'INVALID', reason: 'EVENT_HASH_MISMATCH', checked_at: CUTOFF } }));
  assert.equal(result.status, 'PASS');
});

// --- Trust closure pass: manifest integrity vs. authenticity (Finding 2) -------------------------

test('trust closure: an admin-installed manifest — hash-valid, even claiming the exact control — still cannot satisfy a manifest-only control automatically; a correctly self-computed hash never elevates trust (TNA-42, section 11)', () => {
  const control = getControl('TNA-EVID-001');
  const fakeManifest = buildManifest([{ claim_id: 'fake-1', control_id: 'TNA-EVID-001', component: 'tna-ledger', accepted_tag: 'fake-tag', accepted_commit: 'f'.repeat(40), description: 'Claims the Ledger exposes no mutation route — fabricated by an admin, not part of the accepted baseline.', test_reference: 'none' }]);
  assert.equal(verifyManifestIntegrity(fakeManifest), true); // internally hash-consistent — a correctly self-computed hash
  assert.equal(fakeManifest.trust_class, 'ADMIN_PROVIDED');
  const result = evaluateControl(control, ctx({ manifest: fakeManifest }), bundle([]));
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.reason_codes.includes('MANIFEST_NOT_AUTHENTIC'));
});

test('TNA-CONTAIN-001 (CRITICAL): a self-contradicting SENTINEL_TERMINATED event FAILs regardless of manifest', () => {
  const control = getControl('TNA-CONTAIN-001');
  const bad = mkEvent({ event_type: 'SENTINEL_TERMINATED', tenant_id: TENANT, payload: { containment_status: 'CONTAINMENT_UNCONFIRMED' } });
  assert.equal(evaluateControl(control, ctx(), bundle([bad])).status, 'FAIL');
  const good = mkEvent({ event_type: 'SENTINEL_TERMINATED', tenant_id: TENANT, payload: { containment_status: 'CONTAINMENT_CONFIRMED' } });
  assert.equal(evaluateControl(control, ctx(), bundle([good])).status, 'PASS');
  assert.equal(evaluateControl(control, ctx({ manifest: null }), bundle([good])).status, 'INSUFFICIENT_EVIDENCE');
});

test('TNA-RECOV-001: a SENTINEL_CONTAINMENT_FAILED event that also claims CONTAINMENT_CONFIRMED is a self-contradiction and FAILs', () => {
  const control = getControl('TNA-RECOV-001');
  const contradictory = mkEvent({ event_type: 'SENTINEL_CONTAINMENT_FAILED', tenant_id: TENANT, payload: { containment_status: 'CONTAINMENT_CONFIRMED' } });
  assert.equal(evaluateControl(control, ctx(), bundle([contradictory])).status, 'FAIL');
  const honest = mkEvent({ event_type: 'SENTINEL_CONTAINMENT_FAILED', tenant_id: TENANT, payload: { containment_status: 'CONTAINMENT_UNCONFIRMED' } });
  assert.equal(evaluateControl(control, ctx(), bundle([honest])).status, 'PASS');
});

test('TNA-VER-001: a verifier sharing identity with the atom producer FAILs (no independent verification)', () => {
  const control = getControl('TNA-VER-001');
  const attempt = mkEvent({ event_type: 'ATOM_ATTEMPT_STARTED', tenant_id: TENANT, actor: { type: 'PRODUCER', id: 'same-id' }, spec_context: { atom_id: 'atom-1' } });
  const verify = mkEvent({ event_type: 'ATOM_VERIFICATION_ACCEPTED', tenant_id: TENANT, actor: { type: 'VERIFIER', id: 'same-id' }, spec_context: { atom_id: 'atom-1' } });
  assert.equal(evaluateControl(control, ctx(), bundle([attempt, verify])).status, 'FAIL');
});

test('a disabled/NOT_APPLICABLE control never contributes to risk', () => {
  const control = getControl('TNA-APPR-001');
  const result = evaluateControl(control, ctx(), bundle([]));
  assert.equal(result.status, 'NOT_APPLICABLE');
  assert.equal(result.risk_contribution, 0);
});

test('deterministic replayability: the same control, context, and evidence always produce the same result', () => {
  const control = getControl('TNA-AUTH-001');
  const event = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } });
  const context = ctx();
  const evidence = bundle([event]);
  assert.deepEqual(evaluateControl(control, context, evidence), evaluateControl(control, context, evidence));
});

test('CONTROL_CATALOG_VERSION is a stable, non-empty version string', () => {
  assert.match(CONTROL_CATALOG_VERSION, /^\d+\.\d+$/);
});

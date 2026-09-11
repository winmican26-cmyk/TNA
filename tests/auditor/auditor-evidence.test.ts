import test from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStore, Ledger, writerPrincipal } from '../../packages/ledger-core/src/index.js';
import { LedgerEvidenceProvider, StaticEvidenceProvider, buildAcceptedBaselineManifest, buildManifest, verifyManifestIntegrity, findClaimsForControl, eventRef } from '../../packages/auditor-evidence/src/index.js';
import { AuditorError } from '../../packages/auditor-schema/src/index.js';
import { mkEvent, baseScope, TENANT, CUTOFF } from './fixture.js';

// Ledger.append() stamps received_at from the real system clock (no injectable clock), so these
// real-Ledger integration tests deliberately use a scope/cutoff window around *real* Date.now()
// rather than the fixture's fixed 2026-06 dates (which are only valid against the fixture's own
// injected fake clock, used by the StaticEvidenceProvider-backed tests below).
function realTimeScope(overrides: Partial<ReturnType<typeof baseScope>> = {}) {
  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date(Date.now() + 3600_000).toISOString();
  return { ...baseScope({ time_range: { from, to }, ...overrides }) };
}
function realTimeCutoff(): string { return new Date(Date.now() + 3600_000).toISOString(); }

test('LedgerEvidenceProvider: agent-scoped collection pulls the agent stream and bridges correlated decision evidence across subsystems', async () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const gateWriter = writerPrincipal('gw', TENANT, ['tna-gate']);
  const sentinelWriter = writerPrincipal('sw', TENANT, ['sentinel']);
  ledger.append(gateWriter, { version: '1.0', event_id: 'e1', event_type: 'AGENT_REGISTERED', tenant_id: TENANT, stream_id: 'agent:agent-1', correlation_id: 'agent:agent-1', actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: 'agent-1' } });
  ledger.append(gateWriter, { version: '1.0', event_id: 'e2', event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, stream_id: 'agent:agent-1', correlation_id: 'dec-1', actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } });
  // Sentinel's own stream, correlated to the same decision_id — not in the agent:<id> stream at all.
  ledger.append(sentinelWriter, { version: '1.0', event_id: 'e3', event_type: 'SENTINEL_SESSION_STARTED', tenant_id: TENANT, stream_id: 'sentinel:sess-1', correlation_id: 'dec-1', actor: { type: 'SYSTEM', id: 'sentinel' }, source_component: 'sentinel', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1' } });

  const provider = new LedgerEvidenceProvider(ledger, { readerId: 'auditor-test-reader' });
  const bundle = await provider.collect({ tenant_id: TENANT, scope: realTimeScope({ agent_ids: ['agent-1'] }), evidence_cutoff_at: realTimeCutoff() });
  const types = bundle.events.map(e => e.event_type).sort();
  assert.deepEqual(types, ['AGENT_REGISTERED', 'AUTHORIZATION_ALLOWED', 'SENTINEL_SESSION_STARTED']);
  assert.equal(bundle.stream_integrity['agent:agent-1']?.qualification, 'VALID');
  assert.equal(bundle.stream_integrity['sentinel:sess-1']?.qualification, 'VALID');
  store.close();
});

test('LedgerEvidenceProvider: correlation_ids scope reaches evidence outside any agent stream (e.g. VAD atoms)', async () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const vadWriter = writerPrincipal('vw', TENANT, ['vad-engine']);
  ledger.append(vadWriter, { version: '1.0', event_id: 'e1', event_type: 'ATOM_CREATED', tenant_id: TENANT, stream_id: 'atom:atom-1', correlation_id: 'atom-1', actor: { type: 'SYSTEM', id: 'vad-runtime' }, source_component: 'vad-engine', spec_context: { atom_id: 'atom-1', spec_hash: 's'.repeat(64) } });
  const provider = new LedgerEvidenceProvider(ledger);
  const bundle = await provider.collect({ tenant_id: TENANT, scope: realTimeScope({ agent_ids: [], correlation_ids: ['atom-1'] }), evidence_cutoff_at: realTimeCutoff() });
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.events[0]?.event_type, 'ATOM_CREATED');
  store.close();
});

test('evidence-after-cutoff race (section 107, 18): an event received after evidence_cutoff_at is never included, regardless of when collect() is called', async () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const writer = writerPrincipal('w', TENANT, ['tna-gate']);
  ledger.append(writer, { version: '1.0', event_id: 'before', event_type: 'AGENT_REGISTERED', tenant_id: TENANT, stream_id: 'agent:agent-1', correlation_id: 'agent:agent-1', actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: 'agent-1' } });
  const cutoff = new Date().toISOString();
  await new Promise(r => setTimeout(r, 5));
  ledger.append(writer, { version: '1.0', event_id: 'after', event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, stream_id: 'agent:agent-1', correlation_id: 'dec-1', actor: { type: 'SYSTEM', id: 'tna-gate' }, source_component: 'tna-gate', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy' } });
  const provider = new LedgerEvidenceProvider(ledger);
  // Collect deliberately happens *after* the "after" event was written — the cutoff must still exclude it.
  const bundle = await provider.collect({ tenant_id: TENANT, scope: realTimeScope({ agent_ids: ['agent-1'] }), evidence_cutoff_at: cutoff });
  assert.deepEqual(bundle.events.map(e => e.event_id), ['before']);
  store.close();
});

test('duplicate evidence is deduplicated by event_id, never double-counted (section 67)', async () => {
  const store = new LedgerStore(':memory:');
  const ledger = new Ledger(store);
  const writer = writerPrincipal('w', TENANT, ['tna-gate', 'execution-broker']);
  ledger.append(writer, { version: '1.0', event_id: 'issued', event_type: 'CAPABILITY_ISSUED', tenant_id: TENANT, stream_id: 'agent:agent-1', correlation_id: 'dec-1', actor: { type: 'SYSTEM', id: 'execution-broker' }, source_component: 'execution-broker', authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', capability_id: 'cap-1', authority_expiry: new Date(Date.now() + 3600_000).toISOString() } });
  // Same event reachable via both the agent-stream pull and the actor pull (capabilityRedeemed's actor is the agent itself).
  ledger.append(writer, { version: '1.0', event_id: 'shared', event_type: 'CAPABILITY_REDEEMED', tenant_id: TENANT, stream_id: 'agent:agent-1', correlation_id: 'dec-1', actor: { type: 'AGENT', id: 'agent-1' }, source_component: 'tna-gate', authority_context: { agent_id: 'agent-1', capability_id: 'cap-1' } });
  const provider = new LedgerEvidenceProvider(ledger);
  const bundle = await provider.collect({ tenant_id: TENANT, scope: realTimeScope({ agent_ids: ['agent-1'] }), evidence_cutoff_at: realTimeCutoff() });
  assert.equal(bundle.events.filter(e => e.event_id === 'shared').length, 1);
  store.close();
});

test('evidence conflict: two contradictory authorization outcomes for the same decision are flagged, not silently resolved', async () => {
  const events = [
    mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, event_id: 'e1', authority_context: { decision_id: 'dec-1', agent_id: 'agent-1' } }),
    mkEvent({ event_type: 'AUTHORIZATION_BLOCKED', tenant_id: TENANT, event_id: 'e2', authority_context: { decision_id: 'dec-1', agent_id: 'agent-1' } }),
  ];
  const provider = new StaticEvidenceProvider(events);
  const bundle = await provider.collect({ tenant_id: TENANT, scope: baseScope(), evidence_cutoff_at: CUTOFF });
  assert.equal(bundle.conflicts.length, 1);
  assert.match(bundle.conflicts[0]?.description ?? '', /dec-1/);
});

test('tenant_wide scope requires no agent/correlation match but still respects tenant and time range', async () => {
  const events = [
    mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, actor: { type: 'SYSTEM', id: 'tna-gate' } }),
    mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: 'other-tenant', actor: { type: 'SYSTEM', id: 'tna-gate' } }),
  ];
  const provider = new StaticEvidenceProvider(events);
  const bundle = await provider.collect({ tenant_id: TENANT, scope: { tenant_wide: true, time_range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' } }, evidence_cutoff_at: CUTOFF });
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.events[0]?.tenant_id, TENANT);
});

// --- Implementation manifest (sections 90-92) -----------------------------------------------

test('the accepted baseline manifest is internally hash-consistent and covers every control it claims to', () => {
  const manifest = buildAcceptedBaselineManifest();
  assert.equal(verifyManifestIntegrity(manifest), true);
  assert.ok(manifest.claims.length >= 10);
  for (const claim of manifest.claims) assert.match(claim.accepted_commit, /^[a-f0-9]{40}$/);
});
test('a manifest with content that does not match its own hash fails integrity — forged manifest cannot self-validate', () => {
  const manifest = buildAcceptedBaselineManifest();
  const tampered = { ...manifest, claims: [...manifest.claims, { claim_id: 'injected', control_id: 'TNA-AUTH-001', component: 'fake', accepted_tag: 'fake-v0', accepted_commit: 'a'.repeat(40), description: 'forged', test_reference: 'none' }] };
  assert.equal(verifyManifestIntegrity(tampered), false);
});
test('buildManifest rejects a malformed claim (bad commit shape) rather than silently accepting it', () => {
  assert.throws(() => buildManifest([{ claim_id: 'c1', control_id: 'TNA-AUTH-001', component: 'x', accepted_tag: 'x', accepted_commit: 'not-a-sha', description: 'd', test_reference: 't' }]), (e: unknown) => e instanceof AuditorError && e.code === 'MANIFEST_INVALID');
});
test('findClaimsForControl returns only claims for the requested control', () => {
  const manifest = buildAcceptedBaselineManifest();
  const claims = findClaimsForControl(manifest, 'TNA-CONTAIN-001');
  assert.ok(claims.length >= 1);
  for (const c of claims) assert.equal(c.control_id, 'TNA-CONTAIN-001');
});

test('eventRef produces a VERIFIED_LEDGER-trust reference carrying enough to identify the event immutably, plus its integrity qualification', () => {
  const event = mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, stream_id: 'agent:agent-1' });
  const validRef = eventRef(event, { stream_integrity: { 'agent:agent-1': { qualification: 'VALID', reason: null, checked_at: CUTOFF } } });
  assert.equal(validRef.source_type, 'LEDGER_EVENT');
  assert.equal(validRef.source_trust, 'VERIFIED_LEDGER');
  assert.equal(validRef.event_id, event.event_id);
  assert.equal(validRef.event_hash, event.event_hash);
  assert.equal(validRef.integrity_qualification, 'VALID');
  // A stream absent from the map defensively qualifies as UNVERIFIED, never silently VALID.
  const unknownRef = eventRef(event, { stream_integrity: {} });
  assert.equal(unknownRef.integrity_qualification, 'UNVERIFIED');
});

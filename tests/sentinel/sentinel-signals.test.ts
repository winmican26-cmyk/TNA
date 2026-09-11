import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, type SentinelSession, type SentinelObservation } from '../../packages/sentinel-schema/src/index.js';
import { evaluateRule, hostAllowed, normalizeHostname, normalizeProcessName, type EvaluationContext } from '../../packages/sentinel-signals/src/index.js';
import { type SentinelRuleInput } from '../../packages/sentinel-policy/src/index.js';
import { baseSessionInput, baseObservation } from './fixture.js';

function rule(type: SentinelRuleInput['rule_type'], overrides: Partial<SentinelRuleInput> = {}): SentinelRuleInput {
  return { rule_id: `rule.${type.toLowerCase()}`, rule_type: type, severity: 'HIGH', enabled: true, action: 'TERMINATE', ...overrides };
}
function session(overrides: Record<string, unknown> = {}): SentinelSession {
  const input = baseSessionInput({ tenant_id: 't1', ...overrides } as never);
  return {
    ...input, sentinel_session_id: 's1', started_at: (overrides.started_at as string) ?? '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', status: 'MONITORING', observation_sequence: 0,
    tool_call_count: (overrides.tool_call_count as number) ?? 0, network_request_count: (overrides.network_request_count as number) ?? 0,
    process_spawn_count: (overrides.process_spawn_count as number) ?? 0, session_cost: (overrides.session_cost as number) ?? 0,
    last_heartbeat_at: (overrides.last_heartbeat_at as string | null) ?? null,
  };
}
function observation(overrides: Parameters<typeof baseObservation>[0]): SentinelObservation {
  const input = baseObservation(overrides);
  return { ...input, sequence: 1, received_at: '2026-01-01T00:00:05.000Z' };
}
const NOW = Date.parse('2026-01-01T00:00:00.000Z');

test('AUTHORITY_EXPIRED matches once the clock passes authority_expiry, not before', () => {
  const s = session({ authority_expiry: '2026-01-01T00:00:10.000Z' });
  const ctx: EvaluationContext = { session: s, now: NOW + 5000 };
  assert.equal(evaluateRule(rule('AUTHORITY_EXPIRED'), ctx).status, 'NO_MATCH');
  assert.equal(evaluateRule(rule('AUTHORITY_EXPIRED'), { ...ctx, now: NOW + 15000 }).status, 'MATCH');
});

test('TOOL_NOT_ALLOWED: NOT_APPLICABLE without an observation, NO_MATCH on the expected tool, MATCH on drift', () => {
  const s = session({ expected_tool: 'github' });
  const r = rule('TOOL_NOT_ALLOWED');
  assert.equal(evaluateRule(r, { session: s, now: NOW }).status, 'NOT_APPLICABLE');
  const obsMatch = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github' } });
  assert.equal(evaluateRule(r, { session: s, now: NOW, observation: obsMatch }).status, 'NO_MATCH');
  const obsDrift = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'shell' } });
  const result = evaluateRule(r, { session: s, now: NOW, observation: obsDrift });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.observation_id, obsDrift.observation_id);
});

test('OPERATION_NOT_ALLOWED: a write attempt is rejected when only read is authorized', () => {
  const s = session({ allowed_operations: ['read'] });
  const obs = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'RESOURCE_WRITE', payload: { resource: 'repo:company/app' } });
  assert.equal(evaluateRule(rule('OPERATION_NOT_ALLOWED'), { session: s, now: NOW, observation: obs }).status, 'MATCH');
});

test('RESOURCE_NOT_ALLOWED: separator-aware matching does not let a sibling path through (VAD V2 lesson)', () => {
  const s = session({ expected_resource: 'src/auth/**' });
  const evil = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'RESOURCE_READ', payload: { resource: 'src/auth-evil/file.ts' } });
  assert.equal(evaluateRule(rule('RESOURCE_NOT_ALLOWED'), { session: s, now: NOW, observation: evil }).status, 'MATCH');
  const legit = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'RESOURCE_READ', payload: { resource: 'src/auth/login.ts' } });
  assert.equal(evaluateRule(rule('RESOURCE_NOT_ALLOWED'), { session: s, now: NOW, observation: legit }).status, 'NO_MATCH');
});

test('DESTINATION_NOT_ALLOWED: exact and wildcard allow-list entries both work; an unlisted host is rejected', () => {
  const s = session({ allowed_destinations: ['api.github.com', '*.example.com'] });
  const allowedExact = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'NETWORK_REQUEST', payload: { destination: 'api.github.com' } });
  assert.equal(evaluateRule(rule('DESTINATION_NOT_ALLOWED'), { session: s, now: NOW, observation: allowedExact }).status, 'NO_MATCH');
  const allowedWildcard = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'NETWORK_REQUEST', payload: { destination: 'sub.example.com' } });
  assert.equal(evaluateRule(rule('DESTINATION_NOT_ALLOWED'), { session: s, now: NOW, observation: allowedWildcard }).status, 'NO_MATCH');
  const denied = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'NETWORK_REQUEST', payload: { destination: 'evil.example.org' } });
  assert.equal(evaluateRule(rule('DESTINATION_NOT_ALLOWED'), { session: s, now: NOW, observation: denied }).status, 'MATCH');
});

test('PRIVATE_NETWORK_DESTINATION matches a resolved private address and localhost', () => {
  const s = session({ allowed_destinations: ['*'] });
  const priv = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'NETWORK_REQUEST', payload: { destination: 'internal.example.com', resolved_address: '10.1.2.3' } });
  assert.equal(evaluateRule(rule('PRIVATE_NETWORK_DESTINATION'), { session: s, now: NOW, observation: priv }).status, 'MATCH');
  const loopback = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'NETWORK_REQUEST', payload: { destination: 'localhost' } });
  assert.equal(evaluateRule(rule('PRIVATE_NETWORK_DESTINATION'), { session: s, now: NOW, observation: loopback }).status, 'MATCH');
  const pub = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'NETWORK_REQUEST', payload: { destination: 'api.github.com', resolved_address: '140.82.112.3' } });
  assert.equal(evaluateRule(rule('PRIVATE_NETWORK_DESTINATION'), { session: s, now: NOW, observation: pub }).status, 'NO_MATCH');
});

test('REDIRECT_NOT_ALLOWED evaluates the redirected destination, not the original URL', () => {
  const s = session({ allowed_destinations: ['api.github.com'] });
  const redirect = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'NETWORK_REDIRECT', payload: { from: 'api.github.com', to: 'evil.example.org' } });
  assert.equal(evaluateRule(rule('REDIRECT_NOT_ALLOWED'), { session: s, now: NOW, observation: redirect }).status, 'MATCH');
});

test('RUNTIME_EXCEEDED fires only once the elapsed runtime passes the session limit', () => {
  const s = session({ runtime_limits: { max_runtime_seconds: 60 } });
  assert.equal(evaluateRule(rule('RUNTIME_EXCEEDED'), { session: s, now: NOW + 30_000 }).status, 'NO_MATCH');
  assert.equal(evaluateRule(rule('RUNTIME_EXCEEDED'), { session: s, now: NOW + 61_000 }).status, 'MATCH');
});

test('COST_EXCEEDED fires only once accumulated cost passes the session limit', () => {
  const s = session({ cost_limits: { max_cost_usd: 5 }, session_cost: 6 });
  assert.equal(evaluateRule(rule('COST_EXCEEDED'), { session: s, now: NOW }).status, 'MATCH');
  assert.equal(evaluateRule(rule('COST_EXCEEDED'), { session: session({ cost_limits: { max_cost_usd: 5 }, session_cost: 1 }), now: NOW }).status, 'NO_MATCH');
});

test('TOO_MANY_TOOL_CALLS: a soft WARN below the maximum, a hard match above it', () => {
  const r = rule('TOO_MANY_TOOL_CALLS', { severity: 'MEDIUM', action: 'HOLD', params: { max_tool_calls: 10, warning_threshold: 8 } });
  const approaching = evaluateRule(r, { session: session({ tool_call_count: 8 }), now: NOW });
  assert.equal(approaching.status, 'MATCH');
  assert.equal(approaching.overrideAction, 'WARN');
  assert.equal(approaching.overrideSeverity, 'LOW');
  const breach = evaluateRule(r, { session: session({ tool_call_count: 11 }), now: NOW });
  assert.equal(breach.status, 'MATCH');
  assert.equal(breach.overrideAction, undefined);
  assert.equal(evaluateRule(r, { session: session({ tool_call_count: 3 }), now: NOW }).status, 'NO_MATCH');
});

test('TOO_MANY_NETWORK_REQUESTS matches once the network request count exceeds the configured maximum', () => {
  const r = rule('TOO_MANY_NETWORK_REQUESTS', { severity: 'MEDIUM', action: 'HOLD', params: { max_network_requests: 20 } });
  assert.equal(evaluateRule(r, { session: session({ network_request_count: 15 }), now: NOW }).status, 'NO_MATCH');
  assert.equal(evaluateRule(r, { session: session({ network_request_count: 21 }), now: NOW }).status, 'MATCH');
});
test('TOO_MANY_PROCESS_SPAWNS matches once the process spawn count exceeds the configured maximum', () => {
  const r = rule('TOO_MANY_PROCESS_SPAWNS', { severity: 'MEDIUM', action: 'HOLD', params: { max_process_spawns: 5 } });
  assert.equal(evaluateRule(r, { session: session({ process_spawn_count: 3 }), now: NOW }).status, 'NO_MATCH');
  assert.equal(evaluateRule(r, { session: session({ process_spawn_count: 6 }), now: NOW }).status, 'MATCH');
});

test('UNEXPECTED_PROCESS normalizes Windows executable suffix and case before comparing', () => {
  const s = session({ allowed_processes: ['node', 'git'] });
  const allowed = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'PROCESS_STARTED', payload: { executable: 'NODE.EXE' } });
  assert.equal(evaluateRule(rule('UNEXPECTED_PROCESS'), { session: s, now: NOW, observation: allowed }).status, 'NO_MATCH');
  const unexpected = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'PROCESS_STARTED', payload: { executable: 'powershell.exe' } });
  assert.equal(evaluateRule(rule('UNEXPECTED_PROCESS'), { session: s, now: NOW, observation: unexpected }).status, 'MATCH');
});

test('SECRET_LEASE_NOT_ALLOWED: NOT_APPLICABLE with no allowlist, MATCH outside a configured one', () => {
  const noAllowlist = session();
  const req = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'SECRET_LEASE_REQUESTED', payload: { name: 'db-password' } });
  assert.equal(evaluateRule(rule('SECRET_LEASE_NOT_ALLOWED'), { session: noAllowlist, now: NOW, observation: req }).status, 'NOT_APPLICABLE');
  const withAllowlist = session({ allowed_secrets: ['deploy-token'] });
  assert.equal(evaluateRule(rule('SECRET_LEASE_NOT_ALLOWED'), { session: withAllowlist, now: NOW, observation: req }).status, 'MATCH');
});

test('TOOL_INPUT_HASH_MISMATCH detects a substituted tool input', () => {
  const boundHash = hash('input-a');
  const s = session({ capability_context: { capability_id: 'cap-1', decision_id: 'd1', agent_id: 'agent-1', tool: 'github', operation: 'write', resource: 'repo:company/app', expiry: '2026-01-01T01:00:00.000Z', input_hash: boundHash } });
  const mismatched = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github', input_hash: hash('input-b') } });
  assert.equal(evaluateRule(rule('TOOL_INPUT_HASH_MISMATCH'), { session: s, now: NOW, observation: mismatched }).status, 'MATCH');
  const matched = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'TOOL_CALL_REQUESTED', payload: { tool: 'github', input_hash: boundHash } });
  assert.equal(evaluateRule(rule('TOOL_INPUT_HASH_MISMATCH'), { session: s, now: NOW, observation: matched }).status, 'NO_MATCH');
});

test('CAPABILITY_CONTEXT_MISMATCH detects an inconsistent bound capability field', () => {
  const bound = { capability_id: 'cap-1', decision_id: 'd1', agent_id: 'agent-1', tool: 'github', operation: 'write' as const, resource: 'repo:company/app', expiry: '2026-01-01T01:00:00.000Z', input_hash: hash('x') };
  const s = session({ capability_context: bound });
  const inconsistent = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'TOOL_CALL_STARTED', payload: { capability_context: { ...bound, tool: 'shell' } } });
  assert.equal(evaluateRule(rule('CAPABILITY_CONTEXT_MISMATCH'), { session: s, now: NOW, observation: inconsistent }).status, 'MATCH');
  const consistent = observation({ tenant_id: 't1', sentinel_session_id: 's1', observation_type: 'TOOL_CALL_STARTED', payload: { capability_context: bound } });
  assert.equal(evaluateRule(rule('CAPABILITY_CONTEXT_MISMATCH'), { session: s, now: NOW, observation: consistent }).status, 'NO_MATCH');
});

test('MISSING_HEARTBEAT fires once interval+grace elapses since the last beat (or session start)', () => {
  const s = session({ runtime_limits: { max_runtime_seconds: 3600, heartbeat_interval_seconds: 30, heartbeat_grace_seconds: 10 } });
  assert.equal(evaluateRule(rule('MISSING_HEARTBEAT'), { session: s, now: NOW + 20_000 }).status, 'NO_MATCH');
  assert.equal(evaluateRule(rule('MISSING_HEARTBEAT'), { session: s, now: NOW + 45_000 }).status, 'MATCH');
});

test('AGENT_REVOKED and APPROVAL_REVOKED distinguish revoked scope; UNKNOWN authority fails safe to ERROR', () => {
  const s = session();
  assert.equal(evaluateRule(rule('AGENT_REVOKED'), { session: s, now: NOW }).status, 'NOT_APPLICABLE');
  assert.equal(evaluateRule(rule('AGENT_REVOKED'), { session: s, now: NOW, authorityStatus: { status: 'REVOKED', revokedScope: 'agent' } }).status, 'MATCH');
  assert.equal(evaluateRule(rule('AGENT_REVOKED'), { session: s, now: NOW, authorityStatus: { status: 'REVOKED', revokedScope: 'approval' } }).status, 'NO_MATCH');
  assert.equal(evaluateRule(rule('APPROVAL_REVOKED'), { session: s, now: NOW, authorityStatus: { status: 'REVOKED', revokedScope: 'approval' } }).status, 'MATCH');
  assert.equal(evaluateRule(rule('AGENT_REVOKED'), { session: s, now: NOW, authorityStatus: { status: 'UNKNOWN' } }).status, 'ERROR');
});

test('POLICY_CHANGED matches when the current policy hash diverges from the session-bound snapshot', () => {
  const s = session({ policy_snapshot_hash: hash('policy-v1') });
  assert.equal(evaluateRule(rule('POLICY_CHANGED'), { session: s, now: NOW, authorityStatus: { status: 'VALID' } }).status, 'NO_MATCH');
  assert.equal(evaluateRule(rule('POLICY_CHANGED'), { session: s, now: NOW, authorityStatus: { status: 'POLICY_CHANGED', currentPolicyHash: hash('policy-v2') } }).status, 'MATCH');
});

test('hostAllowed: exact and wildcard normalization (case, trailing dot)', () => {
  assert.equal(hostAllowed('API.GitHub.com.', ['api.github.com']), true);
  assert.equal(hostAllowed('sub.example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('evil.com', ['*.example.com']), false);
});
test('normalizeProcessName strips a Windows executable suffix case-insensitively', () => {
  assert.equal(normalizeProcessName('Node.EXE'), 'node');
  assert.equal(normalizeProcessName('git'), 'git');
});
test('normalizeHostname lowercases and strips one trailing dot', () => {
  assert.equal(normalizeHostname('Example.COM.'), 'example.com');
});

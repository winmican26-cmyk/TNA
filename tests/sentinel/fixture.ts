import { hash, type SentinelSessionInput, type SentinelObservationInput, type ObservationSource, type ObservationType } from '../../packages/sentinel-schema/src/index.js';
import {
  SentinelRuntime, FakeContainmentController, FakeAuthorityRevalidator,
  observerPrincipal, readerPrincipal, controllerPrincipal, adminPrincipal, type SentinelPrincipal,
} from '../../packages/sentinel-runtime/src/index.js';

export interface TestContext {
  runtime: SentinelRuntime; containment: FakeContainmentController; revalidator: FakeAuthorityRevalidator;
  ad: SentinelPrincipal; gw: SentinelPrincipal; bw: SentinelPrincipal; isoW: SentinelPrincipal; egressW: SentinelPrincipal; secretW: SentinelPrincipal;
  rd: SentinelPrincipal; ctrl: SentinelPrincipal; tenantId: string;
  now(): number; advance(ms: number): void;
}

/** A fresh in-memory runtime with the default demo policy installed and every fixed identity handy. */
export function setup(tenantId = 'tenant_demo'): TestContext {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = (): number => current;
  const containment = new FakeContainmentController(clock);
  const revalidator = new FakeAuthorityRevalidator();
  const runtime = new SentinelRuntime(':memory:', { clock, containment, revalidator });
  const ad = adminPrincipal('sentinel-admin', tenantId);
  runtime.installDefaultPolicy(ad);
  return {
    runtime, containment, revalidator, ad,
    gw: observerPrincipal('sentinel-observer-gate', tenantId, ['TNA_GATE']),
    bw: observerPrincipal('sentinel-observer-broker', tenantId, ['EXECUTION_BROKER']),
    isoW: observerPrincipal('sentinel-observer-isolation', tenantId, ['ISOLATION_RUNNER']),
    egressW: observerPrincipal('sentinel-observer-egress', tenantId, ['EGRESS_GUARD']),
    secretW: observerPrincipal('sentinel-observer-secret-broker', tenantId, ['SECRET_BROKER']),
    rd: readerPrincipal('sentinel-reader', tenantId),
    ctrl: controllerPrincipal('sentinel-controller', tenantId),
    tenantId, now: clock, advance: (ms: number) => { current += ms; },
  };
}

/** A minimal, structurally valid session input. Callers override fields per test. */
export function baseSessionInput(overrides: Partial<SentinelSessionInput> & { tenant_id: string }): SentinelSessionInput {
  return {
    version: '1.0',
    tenant_id: overrides.tenant_id,
    agent_id: overrides.agent_id ?? 'agent-1',
    execution_id: overrides.execution_id ?? `exec-${Math.random().toString(36).slice(2)}`,
    correlation_id: overrides.correlation_id ?? 'decision-1',
    authority_snapshot_hash: overrides.authority_snapshot_hash ?? hash('authority-v1'),
    policy_snapshot_hash: overrides.policy_snapshot_hash ?? hash('policy-v1'),
    expected_action: overrides.expected_action ?? 'production.deploy',
    expected_tool: overrides.expected_tool ?? 'github',
    expected_resource: overrides.expected_resource ?? 'repo:company/app',
    allowed_destinations: overrides.allowed_destinations ?? ['api.github.com'],
    allowed_operations: overrides.allowed_operations ?? ['read', 'write'],
    authority_expiry: overrides.authority_expiry ?? '2026-01-01T01:00:00.000Z',
    runtime_limits: overrides.runtime_limits ?? { max_runtime_seconds: 3600 },
    cost_limits: overrides.cost_limits ?? { max_cost_usd: 10 },
    ...(overrides.decision_id !== undefined ? { decision_id: overrides.decision_id } : {}),
    ...(overrides.capability_id !== undefined ? { capability_id: overrides.capability_id } : {}),
    ...(overrides.allowed_processes !== undefined ? { allowed_processes: overrides.allowed_processes } : {}),
    ...(overrides.allowed_secrets !== undefined ? { allowed_secrets: overrides.allowed_secrets } : {}),
    ...(overrides.capability_context !== undefined ? { capability_context: overrides.capability_context } : {}),
  };
}

/** A minimal, structurally valid observation input. Callers override fields per test. */
export function baseObservation(overrides: Partial<SentinelObservationInput> & { tenant_id: string; sentinel_session_id: string }): SentinelObservationInput {
  return {
    version: '1.0',
    observation_id: overrides.observation_id ?? `obs-${Math.random().toString(36).slice(2)}`,
    tenant_id: overrides.tenant_id,
    sentinel_session_id: overrides.sentinel_session_id,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    source: (overrides.source ?? 'EXECUTION_BROKER') as ObservationSource,
    observation_type: (overrides.observation_type ?? 'TOOL_CALL_REQUESTED') as ObservationType,
    ...(overrides.payload !== undefined ? { payload: overrides.payload } : {}),
  };
}

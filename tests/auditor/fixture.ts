import { AuditorRuntime, readerPrincipal, runnerPrincipal, adminPrincipal, type AuditorPrincipal } from '../../packages/auditor-engine/src/index.js';
import { StaticEvidenceProvider, buildManifest, type LedgerEvent, type StreamIntegritySummary, type ControlImplementationClaim } from '../../packages/auditor-evidence/src/index.js';
import type { AssessmentScope } from '../../packages/auditor-schema/src/index.js';

let sequenceCounter = 0;

/** A minimal, structurally valid LedgerEvent. Callers override fields per test. Not routed through
 * real Ledger validation/hashing — StaticEvidenceProvider does not check hashes, matching its role
 * as a deterministic in-memory stand-in (section 65). */
export function mkEvent(overrides: Partial<LedgerEvent> & { event_type: LedgerEvent['event_type']; tenant_id: string }): LedgerEvent {
  sequenceCounter += 1;
  const streamId = overrides.stream_id ?? 'stream-1';
  return {
    version: '1.0',
    event_id: overrides.event_id ?? `evt-${sequenceCounter}`,
    event_type: overrides.event_type,
    tenant_id: overrides.tenant_id,
    stream_id: streamId,
    actor: overrides.actor ?? { type: 'AGENT', id: 'agent-1' },
    correlation_id: overrides.correlation_id ?? 'corr-1',
    source_component: overrides.source_component ?? 'tna-gate',
    sequence: overrides.sequence ?? sequenceCounter,
    received_at: overrides.received_at ?? new Date(Date.parse('2026-06-01T00:00:00.000Z') + sequenceCounter * 1000).toISOString(),
    persisted_at: overrides.persisted_at ?? overrides.received_at ?? new Date(Date.parse('2026-06-01T00:00:00.000Z') + sequenceCounter * 1000).toISOString(),
    payload_hash: overrides.payload_hash ?? 'a'.repeat(64),
    previous_event_hash: overrides.previous_event_hash ?? '0'.repeat(64),
    event_hash: overrides.event_hash ?? 'b'.repeat(64),
    ...(overrides.occurred_at !== undefined ? { occurred_at: overrides.occurred_at } : {}),
    ...(overrides.authority_context !== undefined ? { authority_context: overrides.authority_context } : {}),
    ...(overrides.spec_context !== undefined ? { spec_context: overrides.spec_context } : {}),
    ...(overrides.execution_context !== undefined ? { execution_context: overrides.execution_context } : {}),
    ...(overrides.artifact_context !== undefined ? { artifact_context: overrides.artifact_context } : {}),
    ...(overrides.payload !== undefined ? { payload: overrides.payload } : {}),
  };
}

export function baseScope(overrides: Partial<AssessmentScope> = {}): AssessmentScope {
  return {
    tenant_wide: overrides.tenant_wide ?? false,
    agent_ids: overrides.agent_ids ?? ['agent-1'],
    ...(overrides.correlation_ids !== undefined ? { correlation_ids: overrides.correlation_ids } : {}),
    time_range: overrides.time_range ?? { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' },
  };
}

export const TENANT = 'tenant_demo';
export const CUTOFF = '2026-06-02T00:00:00.000Z';

export interface TestContext {
  runtime: AuditorRuntime;
  admin: AuditorPrincipal; runner: AuditorPrincipal; reader: AuditorPrincipal;
  tenantId: string;
  now(): number; advance(ms: number): void;
}

/**
 * A fresh in-memory runtime backed by a StaticEvidenceProvider seeded with `events`. As of the
 * trust-closure pass, `AuditorRuntime` always computes its own `BUILT_IN_ACCEPTED_BASELINE` manifest
 * internally (section 9-10) — there is no longer a way to "install" it via `setManifest` (that API
 * now rejects any trust_class other than `ADMIN_PROVIDED`, by design), and no way to turn it off.
 * `withAdminManifest` installs a *separate*, `ADMIN_PROVIDED`-classified supplementary manifest —
 * useful only for tests exercising that storage path specifically; it never affects control
 * evaluation (see `auditor-evidence-model-v0.1.md`).
 */
export function setup(events: readonly LedgerEvent[] = [], options: { withAdminManifest?: readonly ControlImplementationClaim[]; streamIntegrity?: Readonly<Record<string, StreamIntegritySummary>> } = {}): TestContext {
  let current = Date.parse('2026-06-02T00:00:01.000Z');
  const clock = (): number => current;
  const provider = new StaticEvidenceProvider(events, options.streamIntegrity ?? {});
  const runtime = new AuditorRuntime(':memory:', { clock, evidenceProvider: provider });
  const admin = adminPrincipal('auditor-admin', TENANT);
  if (options.withAdminManifest) runtime.setManifest(admin, buildManifest(options.withAdminManifest, clock));
  return {
    runtime, admin, runner: runnerPrincipal('auditor-runner', TENANT), reader: readerPrincipal('auditor-reader', TENANT),
    tenantId: TENANT, now: clock, advance: (ms: number) => { current += ms; },
  };
}

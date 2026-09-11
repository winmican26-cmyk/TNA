import { randomUUID } from 'node:crypto';
import { Ledger, readerPrincipal, type LedgerPrincipal, type LedgerEvent, type StreamVerificationResult } from '../../ledger-core/src/index.js';
import {
  MAX_QUERY_PAGE_SIZE, AuditorError, hash, safeId, type EvidenceRef, type AssessmentScope,
  type EvidenceQualification, type ManifestTrustClass,
} from '../../auditor-schema/src/index.js';

export { Ledger, readerPrincipal, type LedgerPrincipal, type LedgerEvent };

// ---------------------------------------------------------------------------------------------
// Evidence bundle (sections 13, 15, 67-68). One immutable, deduplicated snapshot of everything
// collected for one assessment run.
// ---------------------------------------------------------------------------------------------

/** Trust-closure pass: the central, architectural evidence-integrity qualification for one stream
 * (see auditor-evidence-model-v0.1.md and auditor-v0.1-trust-closure.md). Computed once per stream
 * at collection time — never left to an individual control evaluator to (re-)determine. */
export interface StreamIntegritySummary { readonly qualification: EvidenceQualification; readonly reason: string | null; readonly checked_at: string }
export interface EvidenceConflictRecord { readonly description: string; readonly event_ids: readonly string[] }

export interface EvidenceBundle {
  readonly tenant_id: string;
  readonly evidence_cutoff_at: string;
  readonly collected_at: string;
  /** Deduplicated by event_id, sorted by (stream_id, sequence) for determinism. */
  readonly events: readonly LedgerEvent[];
  readonly stream_integrity: Readonly<Record<string, StreamIntegritySummary>>;
  readonly conflicts: readonly EvidenceConflictRecord[];
  readonly truncated: boolean;
}

export interface EvidenceRequest {
  readonly tenant_id: string;
  readonly scope: AssessmentScope;
  readonly evidence_cutoff_at: string;
}

/** Section 65. Bounded, injectable collection — Auditor owns the timeout (section 66), never the caller. */
export interface EvidenceProvider {
  collect(request: EvidenceRequest): Promise<EvidenceBundle>;
}

const MAX_COLLECTED_EVENTS = 5000;
const MAX_PAGES_PER_QUERY = 25;
const DEFAULT_COLLECTION_TIMEOUT_MS = 10_000;

/**
 * Trust-closure pass: `eventRef` now requires the collecting bundle and stamps
 * `integrity_qualification` directly onto the returned ref — the single point where a piece of
 * Ledger evidence is converted into something a control evaluator (or a package reviewer) can cite,
 * so the qualification travels with the reference everywhere it goes, rather than needing to be
 * cross-referenced from a separate map (section 15 of the closure brief). A stream absent from the
 * bundle's `stream_integrity` map (should not happen for anything the provider itself collected, but
 * defensively) qualifies as `UNVERIFIED`, never silently treated as `VALID`.
 */
function eventRef(event: LedgerEvent, bundle: Pick<EvidenceBundle, 'stream_integrity'>): EvidenceRef {
  const summary = bundle.stream_integrity[event.stream_id];
  return {
    source_type: 'LEDGER_EVENT', source_trust: 'VERIFIED_LEDGER', event_id: event.event_id, stream_id: event.stream_id,
    sequence: event.sequence, event_hash: event.event_hash, tenant_id: event.tenant_id, observed_at: event.received_at,
    integrity_qualification: summary?.qualification ?? 'UNVERIFIED',
  };
}
export { eventRef };

function withinCutoff(event: LedgerEvent, cutoffAt: string): boolean { return Date.parse(event.received_at) <= Date.parse(cutoffAt); }
function withinTimeRange(event: LedgerEvent, from: string, to: string): boolean {
  const at = event.occurred_at ?? event.received_at;
  return Date.parse(at) >= Date.parse(from) && Date.parse(at) <= Date.parse(to);
}

/** Section 68: one concrete, well-defined conflict check — two trusted events disagreeing on the
 * outcome of the *same* authorization decision. Not general-purpose contradiction detection; see
 * auditor-evidence-model-v0.1.md for the documented scope of what this does and does not catch. */
function detectConflicts(events: readonly LedgerEvent[]): EvidenceConflictRecord[] {
  const byDecision = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    const decisionId = event.authority_context?.decision_id;
    if (decisionId === undefined) continue;
    if (event.event_type !== 'AUTHORIZATION_ALLOWED' && event.event_type !== 'AUTHORIZATION_BLOCKED' && event.event_type !== 'AUTHORIZATION_HELD') continue;
    const list = byDecision.get(decisionId) ?? [];
    list.push(event);
    byDecision.set(decisionId, list);
  }
  const conflicts: EvidenceConflictRecord[] = [];
  for (const [decisionId, list] of byDecision) {
    const distinctOutcomes = new Set(list.map(e => e.event_type));
    if (distinctOutcomes.size > 1) {
      conflicts.push({ description: `decision ${decisionId} has contradictory authorization outcomes: ${[...distinctOutcomes].join(', ')}`, event_ids: list.map(e => e.event_id) });
    }
  }
  return conflicts;
}

function dedupeAndSort(events: readonly LedgerEvent[]): LedgerEvent[] {
  const byId = new Map<string, LedgerEvent>();
  for (const event of events) byId.set(event.event_id, event);
  return [...byId.values()].sort((a, b) => a.stream_id === b.stream_id ? a.sequence - b.sequence : (a.stream_id < b.stream_id ? -1 : 1));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AuditorError('EVIDENCE_UNAVAILABLE', `Evidence collection exceeded the ${ms}ms runtime-owned timeout`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer!); }
}

/**
 * Primary evidence provider (section 13, 15): TNA Ledger is the preferred source for historical
 * claims, since Gate, VAD, and Sentinel all write their meaningful activity into it through their
 * own adapters. This provider never mutates Ledger and never authenticates as anything but a
 * tenant-scoped reader.
 */
export class LedgerEvidenceProvider implements EvidenceProvider {
  private readonly readerId: string;
  private readonly timeoutMs: number;
  public constructor(private readonly ledger: Ledger, options: { readerId?: string; timeoutMs?: number } = {}) {
    this.readerId = options.readerId ?? 'auditor-reader';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COLLECTION_TIMEOUT_MS;
  }

  public async collect(request: EvidenceRequest): Promise<EvidenceBundle> {
    return withTimeout(this.collectNow(request), this.timeoutMs);
  }

  private async collectNow(request: EvidenceRequest): Promise<EvidenceBundle> {
    const principal: LedgerPrincipal = readerPrincipal(this.readerId, request.tenant_id);
    const { scope, evidence_cutoff_at: cutoff } = request;
    let collected: LedgerEvent[] = [];
    let truncated = false;

    const collectPaged = (fetchPage: (limit: number, cursor?: string) => { items: LedgerEvent[]; nextCursor: string | null }): void => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_QUERY; page += 1) {
        if (collected.length >= MAX_COLLECTED_EVENTS) { truncated = true; return; }
        const result = fetchPage(MAX_QUERY_PAGE_SIZE, cursor);
        collected.push(...result.items);
        if (result.nextCursor === null) return;
        cursor = result.nextCursor;
      }
      truncated = true;
    };

    if (scope.tenant_wide) {
      collectPaged((limit, cursor) => this.ledger.getEventsByTimeRange(principal, scope.time_range.from, scope.time_range.to, limit, cursor));
    } else {
      // Section 15: reaching an agent's full cross-subsystem evidence needs more than one query.
      // Gate writes its own events to a dedicated `agent:<agentId>` stream (GateLedgerAdapter) with
      // `actor` set to the *system component* that acted (e.g. 'tna-gate'), not the agent — so
      // getEventsByActor alone would miss almost everything Gate itself produced. Sentinel's own
      // events do carry `authority_context.agent_id` directly (SentinelLedgerAdapter), which
      // getEventsByActor cannot match on at all. VAD's adapter carries neither an agent-stream nor
      // an authority_context.agent_id — VAD atom evidence for an agent is therefore only reachable
      // by naming the atom's correlation_id explicitly in scope.correlation_ids (documented
      // limitation, see auditor-evidence-model-v0.1.md).
      for (const agentId of scope.agent_ids ?? []) {
        collectPaged((limit, cursor) => this.ledger.getStream(principal, `agent:${agentId}`, limit, cursor));
        collectPaged((limit, cursor) => this.ledger.getEventsByActor(principal, agentId, limit, cursor));
      }
      for (const correlationId of scope.correlation_ids ?? []) collectPaged((limit, cursor) => this.ledger.getEventsByCorrelation(principal, correlationId, limit, cursor));
      // Bridges Sentinel (and any other subsystem binding authority_context.agent_id) evidence that
      // lives outside the agent's own Gate stream, by following each decision_id the agent-stream
      // pull already surfaced.
      const decisionIds = [...new Set(collected.map(e => e.authority_context?.decision_id).filter((v): v is string => v !== undefined))];
      for (const decisionId of decisionIds) {
        if (collected.length >= MAX_COLLECTED_EVENTS) { truncated = true; break; }
        collected.push(...this.ledger.getEventsByDecision(principal, decisionId));
      }
    }

    collected = collected.filter(event => withinCutoff(event, cutoff) && withinTimeRange(event, scope.time_range.from, scope.time_range.to));
    const events = dedupeAndSort(collected);

    const streamIds = [...new Set(events.map(e => e.stream_id))];
    const streamIntegrity: Record<string, StreamIntegritySummary> = {};
    const checkedAt = new Date().toISOString();
    for (const streamId of streamIds) {
      let result: StreamVerificationResult;
      try { result = this.ledger.verifyStream(principal, streamId); }
      // A check that could not run at all is UNAVAILABLE ("we don't know"), never INVALID
      // ("we confirmed it's bad") — the two must not be conflated (section 2 of the closure brief).
      catch { streamIntegrity[streamId] = { qualification: 'UNAVAILABLE', reason: 'VERIFICATION_ERROR', checked_at: checkedAt }; continue; }
      streamIntegrity[streamId] = { qualification: result.valid ? 'VALID' : 'INVALID', reason: result.reason, checked_at: checkedAt };
    }

    return {
      tenant_id: request.tenant_id, evidence_cutoff_at: cutoff, collected_at: new Date().toISOString(),
      events, stream_integrity: streamIntegrity, conflicts: detectConflicts(events), truncated,
    };
  }
}

/** Deterministic, in-memory provider for tests and the demo (section 65: "static fixture provider
 * allowed for tests"). Applies the exact same cutoff/time-range/dedup/conflict rules as the Ledger
 * provider, over a caller-supplied fixed event list, so control-evaluator tests exercise identical
 * evidence-shaping logic without a real Ledger instance. */
export class StaticEvidenceProvider implements EvidenceProvider {
  public constructor(private readonly events: readonly LedgerEvent[], private readonly streamIntegrity: Readonly<Record<string, StreamIntegritySummary>> = {}) {}
  public collect(request: EvidenceRequest): Promise<EvidenceBundle> {
    const { scope, evidence_cutoff_at: cutoff, tenant_id: tenantId } = request;
    const agentIds = scope.agent_ids ?? [];
    // Mirrors LedgerEvidenceProvider's real matching semantics (stream, actor, authority_context.agent_id,
    // and decision-bridged correlation) so fixture-driven tests exercise the same scoping behavior.
    const matchesAgent = (event: LedgerEvent): boolean => agentIds.some(id => event.stream_id === `agent:${id}` || event.actor.id === id || event.authority_context?.agent_id === id);
    const decisionIds = new Set(this.events.filter(matchesAgent).map(e => e.authority_context?.decision_id).filter((v): v is string => v !== undefined));
    const scoped = this.events.filter(event => event.tenant_id === tenantId
      && (scope.tenant_wide || matchesAgent(event) || (scope.correlation_ids ?? []).includes(event.correlation_id) || (event.authority_context?.decision_id !== undefined && decisionIds.has(event.authority_context.decision_id)))
      && withinCutoff(event, cutoff) && withinTimeRange(event, scope.time_range.from, scope.time_range.to));
    const events = dedupeAndSort(scoped);
    const checkedAt = new Date().toISOString();
    const streamIds = [...new Set(events.map(e => e.stream_id))];
    const streamIntegrity: Record<string, StreamIntegritySummary> = {};
    // Test-fixture convenience default: VALID unless the test explicitly overrides a stream's
    // qualification — lets a test corrupt exactly one stream without having to spell out every
    // other stream's integrity state.
    for (const streamId of streamIds) streamIntegrity[streamId] = this.streamIntegrity[streamId] ?? { qualification: 'VALID', reason: null, checked_at: checkedAt };
    return Promise.resolve({ tenant_id: tenantId, evidence_cutoff_at: cutoff, collected_at: checkedAt, events, stream_integrity: streamIntegrity, conflicts: detectConflicts(events), truncated: false });
  }
}

// ---------------------------------------------------------------------------------------------
// Implementation evidence manifest (sections 90-92). Trusted, static, hashed facts about accepted
// TNA components that are not naturally expressed as Ledger events — a control cannot be satisfied
// by an arbitrary caller simply asserting `trusted: true`.
// ---------------------------------------------------------------------------------------------

export interface ControlImplementationClaim {
  readonly claim_id: string;
  readonly control_id: string;
  readonly component: string;
  readonly accepted_tag: string;
  readonly accepted_commit: string;
  readonly description: string;
  readonly test_reference: string;
}

/**
 * Trust-closure pass (`auditor-v0.1-trust-closure.md`, TNA-42): `manifest_hash` proves *integrity* —
 * this exact content was not altered after it was built. It proves nothing about *authenticity* —
 * whether the claims themselves are true. `trust_class` is the separate, orthogonal field that
 * carries provenance, and it is deliberately **not** part of what `manifest_hash` covers: hashing it
 * would only prove "this trust_class value wasn't changed since hashing," which is exactly the kind
 * of self-referential, self-computed proof that cannot establish authenticity (section 8). What
 * actually enforces `trust_class` is code, not cryptography — see `buildAcceptedBaselineManifest`
 * (the only function that can ever produce `BUILT_IN_ACCEPTED_BASELINE`) and
 * `AuditorRuntime.setManifest` (which forces every caller-submitted manifest to `ADMIN_PROVIDED`,
 * rejecting any other declared value outright — section 17's "caller tries
 * trust_classification=BUILT_IN_ACCEPTED_BASELINE → rejected" abuse case).
 */
export interface ControlImplementationManifest {
  readonly version: '1.0';
  readonly manifest_id: string;
  readonly created_at: string;
  readonly claims: readonly ControlImplementationClaim[];
  readonly manifest_hash: string;
  readonly trust_class: ManifestTrustClass;
}

function computeManifestHash(claims: readonly ControlImplementationClaim[]): string { return hash(claims); }

function validateClaims(claims: readonly ControlImplementationClaim[]): void {
  for (const claim of claims) {
    if (!safeId(claim.claim_id, 200) || !safeId(claim.control_id, 200) || !safeId(claim.component, 200) || !safeId(claim.accepted_tag, 200)) throw new AuditorError('MANIFEST_INVALID', `Malformed claim ${JSON.stringify(claim.claim_id)}`);
    if (!/^[a-f0-9]{40}$/.test(claim.accepted_commit)) throw new AuditorError('MANIFEST_INVALID', `Claim ${claim.claim_id} has a malformed accepted_commit (must be a 40-hex git SHA)`);
  }
}

/** Internal-only constructor — the sole place `trust_class` is actually assigned. Not exported: the
 * only way to reach `BUILT_IN_ACCEPTED_BASELINE` is through `buildAcceptedBaselineManifest` below,
 * never through any caller-facing API. */
function buildManifestWithTrustClass(claims: readonly ControlImplementationClaim[], trustClass: ManifestTrustClass, now: () => number, manifestId: string): ControlImplementationManifest {
  validateClaims(claims);
  return { version: '1.0', manifest_id: manifestId, created_at: new Date(now()).toISOString(), claims, manifest_hash: computeManifestHash(claims), trust_class: trustClass };
}

/**
 * Builds and hashes a manifest from caller-supplied claims. Always `trust_class: 'ADMIN_PROVIDED'`
 * — there is no parameter here a caller can use to request any other classification, by design
 * (section 9-10, 17). This is the only way a manifest becomes internally consistent (hash matches
 * content); a manifest is never trusted merely because a `trusted`-shaped flag is set on it by a
 * caller (section 92) — and, since the trust-closure pass, hash-consistency alone never makes a
 * manifest *authentic* either (section 8, 11).
 */
export function buildManifest(claims: readonly ControlImplementationClaim[], now: () => number = Date.now, manifestId: string = randomUUID()): ControlImplementationManifest {
  return buildManifestWithTrustClass(claims, 'ADMIN_PROVIDED', now, manifestId);
}

/** Verifies a manifest's internal integrity: does its hash actually match its own content? This is
 * what prevents a forged manifest ("agent injects fake implementation manifest") from being
 * accepted merely by shape — the hash must be independently recomputable. This says nothing about
 * authenticity (TNA-42) — see `trust_class` and `auditor-evidence-model-v0.1.md`. */
export function verifyManifestIntegrity(manifest: ControlImplementationManifest): boolean {
  return manifest.manifest_hash === computeManifestHash(manifest.claims);
}

export function findClaimsForControl(manifest: ControlImplementationManifest, controlId: string): ControlImplementationClaim[] {
  return manifest.claims.filter(claim => claim.control_id === controlId);
}

/** Section 91: seed manifest describing the six accepted TNA milestones, bound to their exact
 * tags/commits. This is the only manifest this milestone treats as trusted by default — an
 * assessment may be given a different manifest explicitly, but the runtime never fabricates trust
 * for one it did not itself build or receive with a verified hash. */
export function buildAcceptedBaselineManifest(now: () => number = Date.now): ControlImplementationManifest {
  const claims: ControlImplementationClaim[] = [
    { claim_id: 'baseline.gate-v01.identity-binding', control_id: 'TNA-IDENT-001', component: 'tna-gate', accepted_tag: 'tna-gate-v0.1', accepted_commit: '4eca92790d530af73cd81a329ce8acf7085113f5', description: 'Gate v0.1 binds every authorization decision to a registered agent identity; a governed agent is never issued admin/reader authority over another agent.', test_reference: 'tests/gate/*.test.ts (Volume 1 acceptance suite)' },
    { claim_id: 'baseline.gate-v01.capability-single-use', control_id: 'TNA-CAP-002', component: 'execution-broker', accepted_tag: 'tna-gate-v0.1', accepted_commit: '4eca92790d530af73cd81a329ce8acf7085113f5', description: 'Execution broker capability tokens are single-redemption; a second redemption attempt of the same capability_id is rejected.', test_reference: 'tests for capability single-use redemption (Volume 1 acceptance suite)' },
    { claim_id: 'baseline.gate-v02.isolation-runner', control_id: 'TNA-ISO-001', component: 'isolation-runner', accepted_tag: 'tna-gate-v0.2', accepted_commit: 'cdb53bec97d197214a7ca99a964f5d88324da693', description: 'Gate v0.2 mediates execution through an isolation runner and capability brokerage layer rather than direct agent tool access.', test_reference: 'Volume 2 acceptance suite (capability brokerage)' },
    { claim_id: 'baseline.gate-v03.egress-secrets', control_id: 'TNA-EGR-001', component: 'egress-guard', accepted_tag: 'tna-gate-v0.3', accepted_commit: '718a801ff9e3085faf4e69d1dbf924a1b6e6c047', description: 'Gate v0.3 adds application-level egress restriction (destination allow-listing, private-address rejection) and isolated execution — not a full SSRF/network-layer guarantee.', test_reference: 'Volume 3 acceptance suite (isolated execution, egress enforcement)' },
    { claim_id: 'baseline.gate-v03.secret-brokerage', control_id: 'TNA-SEC-001', component: 'secret-broker', accepted_tag: 'tna-gate-v0.3', accepted_commit: '718a801ff9e3085faf4e69d1dbf924a1b6e6c047', description: 'Secret brokerage issues short-lived leases rather than handing agents raw long-lived secrets.', test_reference: 'Volume 3 acceptance suite (secret brokerage)' },
    { claim_id: 'baseline.vad-v01.producer-verifier-separation', control_id: 'TNA-VER-001', component: 'vad-runtime', accepted_tag: 'vad-engine-v0.1', accepted_commit: '0667484cd6c63aef2be81ad85479a91c2bed631a', description: 'VAD Engine v0.1 excludes prior producer conversation history from the verifier’s retry context and binds a distinct verifier identity.', test_reference: '"retry context excludes prior producer conversation history" (Volume 4 acceptance suite)' },
    { claim_id: 'baseline.vad-v01.bounded-retries', control_id: 'TNA-EXEC-002', component: 'vad-runtime', accepted_tag: 'vad-engine-v0.1', accepted_commit: '0667484cd6c63aef2be81ad85479a91c2bed631a', description: 'VAD Engine v0.1 enforces a runtime-owned attempt budget; a caller cannot select or reset the attempt number.', test_reference: '"runtime owns attempt numbers — caller cannot select or reset them" (Volume 4 acceptance suite)' },
    { claim_id: 'baseline.ledger-v01.append-only', control_id: 'TNA-EVID-001', component: 'tna-ledger', accepted_tag: 'tna-ledger-v0.1', accepted_commit: '203b8fb6febe711f7c1f47fa6af8b542ea7f3185', description: 'The accepted Ledger HTTP API exposes no PATCH/PUT/DELETE mutation route for any event or stream; mutation only happens through named, audited append operations.', test_reference: 'Ledger HTTP integration suite (no generic mutation routes)' },
    { claim_id: 'baseline.ledger-v01.integrity-verification', control_id: 'TNA-INTEG-001', component: 'ledger-integrity', accepted_tag: 'tna-ledger-v0.1', accepted_commit: '203b8fb6febe711f7c1f47fa6af8b542ea7f3185', description: 'Ledger streams are hash-chained and independently re-verifiable via verifyStream/verifyAll; tampering is detected, not merely assumed absent.', test_reference: '"state, revocation and evidence persist across restart; tampering is detected" (Volume 5 acceptance suite)' },
    { claim_id: 'baseline.ledger-v01.tenant-isolation', control_id: 'TNA-TEN-001', component: 'ledger-core', accepted_tag: 'tna-ledger-v0.1', accepted_commit: '203b8fb6febe711f7c1f47fa6af8b542ea7f3185', description: 'Every Ledger read/write is scoped by (tenant_id, ...); a cross-tenant caller naming a real stream id gets NOT_FOUND rather than a usable handle.', test_reference: 'Ledger tenant isolation suite' },
    { claim_id: 'baseline.sentinel-v01.policy-drift-rule', control_id: 'TNA-RUNTIME-002', component: 'sentinel-policy', accepted_tag: 'tna-sentinel-v0.1', accepted_commit: 'eda35ecb14ee6c9e9f13112339cda6648cf92303', description: 'Sentinel v0.1’s rule catalog implements POLICY_CHANGED (all 20 rule types from the Sentinel spec are implemented and tested, not partially stubbed).', test_reference: 'sentinel-signals.test.ts "POLICY_CHANGED matches when the current policy hash diverges from the session-bound snapshot"' },
    { claim_id: 'baseline.sentinel-v01.tool-resource-drift-rule', control_id: 'TNA-RUNTIME-003', component: 'sentinel-policy', accepted_tag: 'tna-sentinel-v0.1', accepted_commit: 'eda35ecb14ee6c9e9f13112339cda6648cf92303', description: 'Sentinel v0.1’s rule catalog implements TOOL_NOT_ALLOWED, OPERATION_NOT_ALLOWED, and RESOURCE_NOT_ALLOWED (separator-aware matching, VAD V2 lesson carried forward).', test_reference: 'sentinel-signals.test.ts "TOOL_NOT_ALLOWED / RESOURCE_NOT_ALLOWED" suite' },
    { claim_id: 'baseline.sentinel-v01.active-monitoring', control_id: 'TNA-RUNTIME-001', component: 'sentinel-runtime', accepted_tag: 'tna-sentinel-v0.1', accepted_commit: 'eda35ecb14ee6c9e9f13112339cda6648cf92303', description: 'Sentinel v0.1 provides a runtime session/observation/decision pipeline capable of continuous behavioral monitoring for an authorized execution.', test_reference: 'Sentinel demo Flow A (normal execution monitored, evaluated, completed)' },
    { claim_id: 'baseline.sentinel-v01.authority-revalidation', control_id: 'TNA-RUNTIME-005', component: 'sentinel-runtime', accepted_tag: 'tna-sentinel-v0.1', accepted_commit: 'eda35ecb14ee6c9e9f13112339cda6648cf92303', description: 'Sentinel re-consults authority status on every evaluation rather than caching it from session start; revocation mid-run is detected.', test_reference: 'Sentinel race test "revocation vs. tool call" (Sentinel G2)' },
    { claim_id: 'baseline.sentinel-v01.containment-truthfulness', control_id: 'TNA-CONTAIN-001', component: 'sentinel-runtime', accepted_tag: 'tna-sentinel-v0.1', accepted_commit: 'eda35ecb14ee6c9e9f13112339cda6648cf92303', description: 'Sentinel never reports a termination as confirmed unless the containment call itself did not throw; a concurrency closure pass additionally fixed a mixed-decision race where a stale HOLD could overwrite an already-confirmed TERMINATED status — now prevented by durable CAS/state-version reconciliation, with 14 permanent regression tests.', test_reference: 'tests/sentinel/sentinel-concurrency-closure.test.ts; sentinel-v0.1-concurrency-closure.md' },
    { claim_id: 'baseline.sentinel-v01.emergency-stop', control_id: 'TNA-CONTAIN-002', component: 'sentinel-runtime', accepted_tag: 'tna-sentinel-v0.1', accepted_commit: 'eda35ecb14ee6c9e9f13112339cda6648cf92303', description: 'Sentinel emergency stop is durably persisted, tenant/agent/session scoped, admin-only to activate or release, and checked before every evaluation.', test_reference: 'Sentinel emergency-stop suite (session/agent/tenant scopes, cross-tenant isolation, restart persistence)' },
    { claim_id: 'baseline.sentinel-v01.recovery-honesty', control_id: 'TNA-RECOV-001', component: 'sentinel-runtime', accepted_tag: 'tna-sentinel-v0.1', accepted_commit: 'eda35ecb14ee6c9e9f13112339cda6648cf92303', description: 'An unconfirmed containment outcome resolves to INDETERMINATE, never a false TERMINATED or a silently-overwritten HELD.', test_reference: '"containment failure resolves the session to INDETERMINATE, never falsely TERMINATED"; concurrency closure HOLD-vs-INDETERMINATE regression' },
  ];
  // BUILT_IN_ACCEPTED_BASELINE — generated by trusted, compiled code from the pinned accepted
  // tag/commit anchors above, never from caller input (section 9-10). This is the only call site in
  // the codebase that can produce this trust class.
  return buildManifestWithTrustClass(claims, 'BUILT_IN_ACCEPTED_BASELINE', now, 'accepted-baseline-manifest-v0.1');
}

import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Gate } from '../../apps/tna-gate-api/src/gate.js';
import { Store } from '../../packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../../packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../../packages/execution-broker/src/index.js';
import { LedgerStore, Ledger, writerPrincipal as ledgerWriterPrincipal } from '../../packages/ledger-core/src/index.js';
import { SentinelRuntime, adminPrincipal as sentinelAdmin, controllerPrincipal as sentinelController, observerPrincipal as sentinelObserverFactory } from '../../packages/sentinel-runtime/src/index.js';
import { PlatformExecutionOrchestrator, PlatformGateOrchestrator, PlatformControlOrchestrator, PlatformFacade, PlatformStore, type GatePort } from '../../packages/platform-core/src/index.js';
import { createPlatformServer } from '../../apps/tna-platform/src/server.js';
import { ClientStore } from '../../packages/client-core/src/index.js';
import { createClientGatewayServer } from '../../apps/tna-client-gateway/src/server.js';
import { createLedgerServer } from '../../apps/tna-ledger/src/server.js';
import { AuditorRuntime, runnerPrincipal as auditorRunnerPrincipal } from '../../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../../packages/auditor-evidence/src/index.js';
import { createAuditorServer } from '../../apps/tna-auditor/src/server.js';
import { ImprovementStore } from '../../packages/improvement-store/src/index.js';
import { createImprovementGovernorServer } from '../../apps/tna-improvement-governor/src/server.js';
import type { AuthorityCeiling, CapabilityProfile, RequiredTestManifest } from '../../packages/improvement-schema/src/index.js';
import { ControlCenterSessionStore } from '../../apps/tna-control-center/src/session-store.js';
import { tenantRegistryFromEntries } from '../../apps/tna-control-center/src/tenant-registry.js';
import { PlatformProxyClient } from '../../apps/tna-control-center/src/platform-client.js';
import { ClientGatewayProxyClient, type ClientGatewayConfig } from '../../apps/tna-control-center/src/client-gateway-client.js';
import { LedgerProxyClient } from '../../apps/tna-control-center/src/ledger-client.js';
import { AuditorProxyClient } from '../../apps/tna-control-center/src/auditor-client.js';
import { ImprovementGovernorProxyClient } from '../../apps/tna-control-center/src/improvement-client.js';
import { createControlCenterServer } from '../../apps/tna-control-center/src/server.js';
import type { TenantRegistryEntry } from '../../apps/tna-control-center/src/schema.js';
import { NOW, envelope } from '../fixture.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) test harness. Every test in this directory
 * runs against a REAL, complete, in-memory Platform stack (mirrors `tests/platform/platform-http.test.ts`'s
 * own harness exactly) and a REAL Control Center BFF process object — no mocked APIs, no canned JSON.
 */

export const AGENT = 'deployment-agent-17';
export function credentials(seed: string) {
  return {
    agentTokens: { [`agent-token-${seed}-${'a'.repeat(20)}`]: AGENT },
    operatorToken: `operator-token-${seed}-32-characters-x`,
    adminToken: `admin-token-${seed}-32-characters-xxxx`,
    serviceToken: `service-token-${seed}-32-characters-xx`,
  };
}

export interface RealPlatform {
  readonly baseUrl: string;
  readonly agentToken: string;
  readonly operatorToken: string;
  readonly close: () => Promise<void>;
}

export async function startRealPlatform(tenantId: string, seed: string): Promise<RealPlatform> {
  const dir = mkdtempSync(resolve(tmpdir(), `cc-platform-${seed}-`));
  const gateEvidence = new Store(':memory:');
  const gate = new Gate(gateEvidence, () => NOW);
  const CREDENTIALS = credentials(seed);
  const agentToken = Object.keys(CREDENTIALS.agentTokens)[0]!;
  gate.register({ kind: 'admin', role: 'administrator' }, { id: AGENT, name: 'Deployment Agent' });
  gate.setEnvelope({ kind: 'admin', role: 'administrator' }, envelope());
  const registry = new ToolRegistry();
  registry.register({ name: 'log.write', action: 'log.write', resourceType: 'files', allowedOperations: ['read'], networkRequired: false, credentialsRequired: [], handler: context => ({ echoed: context.input }) });
  const broker = new ExecutionBroker(gateEvidence, new CapabilityCodec(randomBytes(32)), registry);
  const sentinel = new SentinelRuntime(':memory:', { clock: () => NOW });
  sentinel.installDefaultPolicy(sentinelAdmin('sentinel-admin', tenantId));
  const ledgerStore = new LedgerStore(':memory:');
  const platform = new PlatformStore(resolve(dir, 'platform.sqlite'), { clock: () => NOW });
  const gatePort: GatePort = { authorize: (principal, req) => gate.authorize(principal, req) };
  const gateOrchestrator = new PlatformGateOrchestrator(platform, gatePort);
  const executionOrchestrator = new PlatformExecutionOrchestrator(platform, broker, sentinel, sentinelController(`c-${seed}`, tenantId), sentinelObserverFactory(`o-${seed}`, tenantId, ['EXECUTION_BROKER']));
  const control = new PlatformControlOrchestrator(platform);
  const facade = new PlatformFacade(platform, gateOrchestrator, executionOrchestrator);
  const server = createPlatformServer({ store: platform, facade, control }, CREDENTIALS, tenantId);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`, agentToken, operatorToken: CREDENTIALS.operatorToken,
    close: async () => {
      await new Promise<void>(res => server.close(() => res()));
      platform.close(); gateEvidence.close(); sentinel.close(); ledgerStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface RealClientGateway {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly store: ClientStore;
  readonly close: () => Promise<void>;
}

/** Real, in-process Client Gateway in `'record-only'` mode — sufficient for every Control Center test in
 * this suite, since none of them exercise `/v1/client/actions` governed execution, only the real ADMIN
 * API (tenants/services/mcp-servers/tools) that IS this integration's whole surface. A real `ClientStore`
 * backs it (`:memory:` — no disposable directory needed), and `createClientGatewayServer` is the real,
 * accepted, unmodified server factory — never a reimplementation. */
export async function startRealClientGateway(seed: string): Promise<RealClientGateway> {
  const store = new ClientStore(':memory:');
  const adminToken = `cg-admin-token-${seed}-${'x'.repeat(20)}`;
  const server = createClientGatewayServer({ store, mode: 'record-only' }, adminToken);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`, adminToken, store,
    close: async () => { await new Promise<void>(res => server.close(() => res())); store.close(); },
  };
}

export interface RealLedger {
  readonly baseUrl: string;
  readonly readerToken: string;
  readonly adminToken: string;
  readonly ledger: Ledger;
  readonly ledgerStore: LedgerStore;
  readonly close: () => Promise<void>;
}
export async function startRealLedger(tenantId: string, seed: string): Promise<RealLedger> {
  const ledgerStore = new LedgerStore(':memory:');
  const ledger = new Ledger(ledgerStore);
  const credentials = { writerGateToken: `lw-gate-${seed}-${'x'.repeat(20)}`, writerVadToken: `lw-vad-${seed}-${'x'.repeat(20)}`, readerToken: `lr-${seed}-${'x'.repeat(24)}`, adminToken: `la-${seed}-${'x'.repeat(24)}` };
  const server = createLedgerServer(ledger, credentials, tenantId);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`, readerToken: credentials.readerToken, adminToken: credentials.adminToken, ledger, ledgerStore,
    close: async () => { await new Promise<void>(res => server.close(() => res())); ledgerStore.close(); },
  };
}
/** Seeds one real, hash-chained Ledger event via the real writer principal — never a fabricated row. */
export function seedLedgerEvent(rl: RealLedger, tenantId: string, overrides: Record<string, unknown> = {}): unknown {
  const gw = ledgerWriterPrincipal('ledger-writer-gate', tenantId, ['tna-gate']);
  return rl.ledger.append(gw, {
    version: '1.0', event_id: `evt-${Math.random().toString(36).slice(2)}`, event_type: 'AGENT_REGISTERED',
    tenant_id: tenantId, stream_id: 'agent:cc-test', actor: { type: 'SYSTEM', id: 'tna-gate' },
    correlation_id: 'agent:cc-test', source_component: 'tna-gate', ...overrides,
  } as never);
}

export interface RealAuditor {
  readonly baseUrl: string;
  readonly readerToken: string;
  readonly runtime: AuditorRuntime;
  readonly close: () => Promise<void>;
}
export async function startRealAuditor(tenantId: string, seed: string, ledger: Ledger): Promise<RealAuditor> {
  const provider = new LedgerEvidenceProvider(ledger, { readerId: `auditor-reader-${seed}` });
  const runtime = new AuditorRuntime(':memory:', { evidenceProvider: provider });
  const credentials = { readerToken: `ar-${seed}-${'x'.repeat(24)}`, runnerToken: `arun-${seed}-${'x'.repeat(20)}`, adminToken: `aadm-${seed}-${'x'.repeat(20)}` };
  const server = createAuditorServer(runtime, credentials, tenantId);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`, readerToken: credentials.readerToken, runtime,
    close: async () => { await new Promise<void>(res => server.close(() => res())); runtime.close(); },
  };
}
/** Creates one real assessment directly via the runtime (the Control Center never creates assessments
 * itself — `audit.read` is a read-only permission by design; assessment creation/running remains
 * operator-level tooling). */
export function seedRealAssessment(auditor: RealAuditor, tenantId: string): { assessment_id: string } {
  const principal = auditorRunnerPrincipal(`runner-${tenantId}`, tenantId);
  const now = new Date().toISOString();
  const assessment = auditor.runtime.createAssessment(principal, {
    version: '1.0', tenant_id: tenantId, name: 'Control Center integration test assessment',
    control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: now,
    scope: { tenant_wide: true, time_range: { from: '2020-01-01T00:00:00.000Z', to: now } },
  });
  return { assessment_id: assessment.assessment_id };
}

export interface RealImprovementGovernor {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly store: ImprovementStore;
  readonly close: () => Promise<void>;
}

const IMPROVEMENT_FIXTURE_ROOT = resolve('improvement', 'fixtures', 'demo-agent');

function readOnlyCeiling(overrides: Partial<AuthorityCeiling> = {}): AuthorityCeiling {
  return { operations: ['read'], tools: [], resources: [], destinations: [], network_access: false, filesystem_scope: [], credentials: [], max_budget_usd: 1, max_runtime_ms: 60_000, max_parallelism: 1, external_side_effects: false, requires_approval_for: [], ...overrides };
}
function readOnlyCapability(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return { tools: [], operations: ['read'], resources: [], destinations: [], filesystem_writes: false, network_access: false, credential_access: [], code_execution: false, max_parallelism: 1, side_effect_classes: [], ...overrides };
}
function improvementManifest(): RequiredTestManifest {
  return { manifest_id: 'm1', manifest_version: 1, entries: [{ test_id: 't1', path: 'regression.mjs', content_hash: null, required: true, source: 'accepted' }], manifest_hash: 'h1' };
}

/** Real, in-process Recursive Improvement Governor (Volume 12's own packaged server — never a
 * reimplementation) with a real Gate/Ledger/Sentinel/ImprovementStore stack behind it, mirroring
 * `tests/improvement/http.test.ts`'s own harness exactly. */
export async function startRealImprovementGovernor(tenantId: string, seed: string): Promise<RealImprovementGovernor> {
  const dir = mkdtempSync(resolve(tmpdir(), `cc-improvement-${seed}-`));
  const store = new ImprovementStore(resolve(dir, 'improvement.sqlite'));
  const gateStore = new Store(resolve(dir, 'gate.sqlite'));
  const gate = new Gate(gateStore);
  const ledgerStore = new LedgerStore(resolve(dir, 'ledger.sqlite'));
  const ledger = new Ledger(ledgerStore);
  const sentinel = new SentinelRuntime(resolve(dir, 'sentinel.sqlite'));
  const adminToken = `ig-admin-${seed}-${'x'.repeat(24)}`;
  const server = createImprovementGovernorServer({
    store, gate, ledger, ledgerStore, sentinel, tenantId, governorAgentId: `improvement-governor-${seed}`,
    approverRole: 'improvement-approver', adminToken,
  });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`, adminToken, store,
    close: async () => {
      await new Promise<void>(res => server.close(() => res()));
      store.close(); gateStore.close(); ledgerStore.close(); sentinel.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Drives the REAL golden-path lineage the flagship mockup depicts, entirely over real HTTP against the
 * real governor: a root generation is PROMOTED (becomes the system's accepted generation); a sibling
 * candidate that attempts an authority-ceiling escalation is REJECTED; a second, non-escalating sibling is
 * then PROMOTED in turn — "a successor can become better without automatically becoming more powerful"
 * demonstrated with real Gate/VAD/Ledger-backed outcomes, never fabricated ones. */
export async function seedRealLineage(gov: RealImprovementGovernor, systemId: string): Promise<{ readonly internalSystemId: string; readonly promotedGenerationId: string; readonly rejectedGenerationId: string; readonly secondPromotedGenerationId: string }> {
  async function api(method: string, path: string, bodyObj?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${gov.baseUrl}${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gov.adminToken}` },
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  }
  async function proposeThroughPromotion(objective: string, parentGenerationId: string | null, authorityOverrides: Partial<AuthorityCeiling> = {}): Promise<{ generationId: string; internalSystemId: string; finalStatus: string }> {
    const created = await api('POST', '/v1/improvements', {
      systemId, systemName: systemId, parentGenerationId, parentWorkspacePath: IMPROVEMENT_FIXTURE_ROOT,
      objective, improvementClass: 'CLASS_1_CODE', allowedMutationPaths: ['router.mjs'],
      authorityCeiling: readOnlyCeiling(), candidateVersion: 'v1', createdBy: 'control-center-lineage-seed', requiredBenchmarks: ['routing-accuracy'],
    });
    // The real governor's `GET /v1/improvements?systemId=` route (and this BFF's proxy of it) filters on
    // the store's own INTERNALLY-MINTED `system_id`, never the caller-chosen identifier passed as
    // `systemId` at creation time (that value is only ever stored as the system's `name`, used for
    // idempotent re-lookup on a later `/v1/improvements` POST — see `handleCreate`'s own documented
    // distinction). Callers that need to list a system's generations must use this real internal id.
    const generation = created.json.generation as { generation_id: string; system_id: string };
    const generationId = generation.generation_id;
    await api('POST', `/v1/improvements/${generationId}/authorize`);
    await api('POST', `/v1/improvements/${generationId}/build`, {});
    const evaluated = await api('POST', `/v1/improvements/${generationId}/evaluate`, {
      regressionTestCommand: [process.execPath, 'regression.mjs'], benchmarks: [{ benchmarkId: 'routing-accuracy', command: [process.execPath, 'benchmark.mjs'], threshold: 0.0, parentScore: 0.75 }],
      parentCapabilityProfile: readOnlyCapability(), candidateCapabilityProfile: readOnlyCapability(),
      candidateAuthorityProfile: readOnlyCeiling(authorityOverrides),
      requiredTestManifestBefore: improvementManifest(), requiredTestManifestAfter: improvementManifest(), evaluationProfileHash: `lineage-seed-${systemId}`,
    });
    const finalStatus = (evaluated.json.evaluation as { status: string }).status;
    if (finalStatus !== 'PROMOTE') return { generationId, internalSystemId: generation.system_id, finalStatus: (evaluated.json.generation as { status: string }).status };

    const canaryApproval = await api('POST', `/v1/improvements/${generationId}/approve`, { operation: 'start_canary' });
    const canaryApprovalId = (canaryApproval.json.approval as { approvalId: string }).approvalId;
    await api('POST', `/v1/improvements/${generationId}/canary`, { approvalId: canaryApprovalId });
    const promoteApproval = await api('POST', `/v1/improvements/${generationId}/approve`, { operation: 'promote' });
    const promoteApprovalId = (promoteApproval.json.approval as { approvalId: string }).approvalId;
    const promoted = await api('POST', `/v1/improvements/${generationId}/promote`, { approvalId: promoteApprovalId });
    return { generationId, internalSystemId: generation.system_id, finalStatus: (promoted.json.generation as { status: string }).status };
  }

  const first = await proposeThroughPromotion('improve routing accuracy (baseline)', null);
  if (first.finalStatus !== 'PROMOTED') throw new Error(`Lineage seed's baseline generation did not reach PROMOTED (got ${first.finalStatus}) — cannot seed a realistic lineage`);

  const escalation = await proposeThroughPromotion('improve accuracy while requesting write access', first.generationId, { operations: ['read', 'write'] });
  if (escalation.finalStatus !== 'REJECTED') throw new Error(`Lineage seed's authority-escalating generation did not reach REJECTED (got ${escalation.finalStatus})`);

  const second = await proposeThroughPromotion('improve routing accuracy further (no authority change)', first.generationId);
  if (second.finalStatus !== 'PROMOTED') throw new Error(`Lineage seed's second generation did not reach PROMOTED (got ${second.finalStatus})`);

  return { internalSystemId: first.internalSystemId, promotedGenerationId: first.generationId, rejectedGenerationId: escalation.generationId, secondPromotedGenerationId: second.generationId };
}

export async function submitAction(platform: RealPlatform, requestId: string, patch: Record<string, unknown> = {}, tenantId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${platform.baseUrl}/v1/platform/actions`, {
    method: 'POST', headers: { Authorization: `Bearer ${platform.agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: '1.0', request_id: requestId, tenant_id: tenantId, agent_id: AGENT, action: 'log.write', tool: 'log.write', operation: 'write', resource: '/workspace/logs/deploy.log', input: { message: 'hello' }, requires_verification: false, ...patch }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

export interface RealControlCenter {
  readonly baseUrl: string;
  readonly sessions: ControlCenterSessionStore;
  readonly close: () => Promise<void>;
}

/** A mutable, injectable clock — foundation-review section 6: expiry must be provable deterministically,
 * never only by sleeping in a test for real wall-clock time to pass. */
export class TestClock {
  private current: number;
  public constructor(startAt: number = Date.now()) { this.current = startAt; }
  public now = (): number => this.current;
  public advance(ms: number): void { this.current += ms; }
}

export async function startControlCenter(entries: readonly TenantRegistryEntry[], options: { readonly clock?: TestClock; readonly staticRoot?: string | null; readonly clientGateway?: ClientGatewayConfig | null; readonly environment?: 'development' | 'staging' | 'production'; readonly trustedOrigins?: readonly string[] } = {}): Promise<RealControlCenter> {
  const dir = mkdtempSync(resolve(tmpdir(), 'cc-server-'));
  const sessions = new ControlCenterSessionStore(resolve(dir, 'cc.sqlite'), options.clock ? { clock: options.clock.now } : {});
  const tenants = tenantRegistryFromEntries(entries);
  const platform = new PlatformProxyClient();
  const clientGateway = options.clientGateway ?? null;
  const clientGatewayClient = clientGateway ? new ClientGatewayProxyClient() : null;
  const server = createControlCenterServer({
    sessions, tenants, platform, cookieSecure: false, staticRoot: options.staticRoot ?? null, clientGateway, clientGatewayClient,
    ledger: new LedgerProxyClient(), auditor: new AuditorProxyClient(), improvement: new ImprovementGovernorProxyClient(),
    environment: options.environment, trustedOrigins: options.trustedOrigins,
  });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`, sessions,
    close: async () => { await new Promise<void>(res => server.close(() => res())); sessions.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A tiny, real, manual cookie jar — Node's `fetch` does not manage cookies automatically, so browser
 * -like session persistence across requests is reproduced explicitly here rather than skipped. */
export class CookieJar {
  private jar = new Map<string, string>();
  public capture(res: Response): void {
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (!name) continue;
      if (value === '' ) this.jar.delete(name); else this.jar.set(name, value);
    }
  }
  public header(): string { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  public get(name: string): string | undefined { return this.jar.get(name); }
}

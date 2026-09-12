/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Section 20-22: `tna incident collect`
 * — a bounded, secret-redacted support/incident package. Section 21: `IncidentPackageManifest v1` binds
 * every included file with a SHA-256 hash so the package is tamper-evident. Section 22: `--tenant`
 * scoping relies on the same tenant-scoped accepted APIs every other command uses (the platform client
 * is bound to one deployment tenant by construction; the client-gateway client only ever queries the
 * one tenant id it is given) — this module never aggregates across tenants itself.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PlatformClient, ClientGatewayClient } from './http-client.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import { redactDeep } from './redact.js';
import { explain } from './explain.js';

export const INCIDENT_MAX_ACTIONS = 25;

export interface IncidentPackageFile {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface IncidentPackageManifest {
  readonly version: '1.0';
  readonly package_id: string;
  readonly created_at: string;
  readonly tenant_scope: string | null;
  readonly files: readonly IncidentPackageFile[];
  readonly manifest_hash: string;
}

export interface IncidentPackage {
  readonly manifest: IncidentPackageManifest;
  readonly doctor: DoctorReport;
  readonly platform_diagnostics: unknown;
  readonly client_gateway_health: unknown;
  readonly recent_actions: readonly { readonly platform_action_id: string; readonly state: string; readonly error_code: string | null; readonly explanation: ReturnType<typeof explain> }[];
}

function sha256(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function buildManifest(tenantScope: string | null, sections: Record<string, unknown>): IncidentPackageManifest {
  const files: IncidentPackageFile[] = Object.entries(sections).map(([name, content]) => {
    const serialized = JSON.stringify(content);
    return { name, sha256: sha256(content), bytes: Buffer.byteLength(serialized, 'utf8') };
  });
  const packageId = `inc_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const manifestHash = sha256({ package_id: packageId, created_at: createdAt, tenant_scope: tenantScope, files });
  return { version: '1.0', package_id: packageId, created_at: createdAt, tenant_scope: tenantScope, files, manifest_hash: manifestHash };
}

export async function collectIncidentPackage(deps: { platform?: PlatformClient | undefined; clientGateway?: ClientGatewayClient | undefined; tenantId?: string | undefined }): Promise<IncidentPackage> {
  const doctor = await runDoctor({ platform: deps.platform, clientGateway: deps.clientGateway });

  let platformDiagnostics: unknown = null;
  let recentActions: IncidentPackage['recent_actions'] = [];
  if (deps.platform) {
    try { platformDiagnostics = redactDeep(await deps.platform.diagnostics()); } catch { platformDiagnostics = { error: 'unavailable' }; }
    try {
      const list = await deps.platform.listActions({ limit: INCIDENT_MAX_ACTIONS }) as { items: { platform_action_id: string; state: string; error_code: string | null; gate_decision: { decision: string; reason: string } | null }[] };
      recentActions = list.items.map(item => ({
        platform_action_id: item.platform_action_id, state: item.state, error_code: item.error_code,
        explanation: explain({ state: item.state, error_code: item.error_code, error_message: null, gate_decision: item.gate_decision }),
      }));
    } catch { recentActions = []; }
  }

  let clientGatewayHealth: unknown = null;
  if (deps.clientGateway && deps.tenantId) {
    try { clientGatewayHealth = redactDeep(await deps.clientGateway.health(deps.tenantId)); }
    catch (error) { clientGatewayHealth = { error: error instanceof Error ? error.message : 'unavailable' }; }
  }

  const sections = { doctor: redactDeep(doctor), platform_diagnostics: platformDiagnostics, client_gateway_health: clientGatewayHealth, recent_actions: recentActions };
  const manifest = buildManifest(deps.tenantId ?? null, sections);
  return { manifest, doctor, platform_diagnostics: platformDiagnostics, client_gateway_health: clientGatewayHealth, recent_actions: recentActions };
}

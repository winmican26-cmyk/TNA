/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Section 17-19: `tna doctor` — a
 * READ-ONLY diagnostic aggregation over the platform's real `/ready` and `/diagnostics` routes and the
 * client gateway's real `/ready` route. Never repairs, approves, resets, rotates, or deletes anything
 * (section 18) — every check here is a GET.
 */
import type { PlatformClient, ClientGatewayClient } from './http-client.js';

export type DiagnosticStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface DiagnosticCheck {
  readonly check_id: string;
  readonly status: DiagnosticStatus;
  readonly summary: string;
  readonly evidence?: unknown;
  readonly guidance?: string;
}

export interface DoctorReport {
  readonly overall: DiagnosticStatus;
  readonly checks: readonly DiagnosticCheck[];
}

function worseOf(a: DiagnosticStatus, b: DiagnosticStatus): DiagnosticStatus {
  const rank: Readonly<Record<DiagnosticStatus, number>> = { PASS: 0, UNKNOWN: 1, WARN: 2, FAIL: 3 };
  return rank[b] > rank[a] ? b : a;
}

interface PlatformReadiness { ready: boolean; status: string; components: readonly { component: string; status: string; mandatory: boolean; message?: string }[] }
interface PlatformDiagnostics { component_versions: Record<string, string>; config_hash: string; deployment_id: string; outbox_pending: number; outbox_dead_letter: number }
interface ClientGatewayReadiness { ready: boolean; status: string; mode?: string; governed_execution?: boolean }

export async function runDoctor(deps: { platform?: PlatformClient | undefined; clientGateway?: ClientGatewayClient | undefined }): Promise<DoctorReport> {
  const checks: DiagnosticCheck[] = [];

  if (deps.platform) {
    try {
      const readiness = await deps.platform.ready() as PlatformReadiness;
      for (const component of readiness.components) {
        const status: DiagnosticStatus = component.status === 'AVAILABLE' ? 'PASS' : component.mandatory ? 'FAIL' : 'WARN';
        checks.push({
          check_id: `platform.${component.component}`, status,
          summary: `Platform component "${component.component}" is ${component.status}${component.message ? ` (${component.message})` : ''}`,
          evidence: component,
          ...(status !== 'PASS' ? { guidance: component.mandatory ? 'This is a mandatory dependency — new consequential actions cannot be authorized until it recovers.' : 'This is an optional dependency — core execution remains available, but this feature is degraded.' } : {}),
        });
      }
    } catch (error) {
      checks.push({ check_id: 'platform.readiness', status: 'FAIL', summary: 'Could not reach the platform /ready endpoint', evidence: { error: error instanceof Error ? error.message : String(error) }, guidance: 'Verify the platform process is running and the configured platformUrl is correct.' });
    }
    try {
      const diagnostics = await deps.platform.diagnostics() as PlatformDiagnostics;
      checks.push({
        check_id: 'platform.outbox_dead_letter',
        status: diagnostics.outbox_dead_letter > 0 ? 'FAIL' : 'PASS',
        summary: `Outbox dead-letter count: ${diagnostics.outbox_dead_letter}`,
        evidence: { outbox_dead_letter: diagnostics.outbox_dead_letter },
        ...(diagnostics.outbox_dead_letter > 0 ? { guidance: 'One or more evidence-delivery events exhausted their retry budget. Investigate the Ledger connection and the specific dead-lettered events before relying on evidence completeness.' } : {}),
      });
      checks.push({
        check_id: 'platform.outbox_pending',
        status: diagnostics.outbox_pending > 50 ? 'WARN' : 'PASS',
        summary: `Outbox pending count: ${diagnostics.outbox_pending}`,
        evidence: { outbox_pending: diagnostics.outbox_pending },
      });
      checks.push({ check_id: 'platform.version', status: 'PASS', summary: `Deployment ${diagnostics.deployment_id}, config_hash ${diagnostics.config_hash.slice(0, 12)}…`, evidence: diagnostics.component_versions });
    } catch (error) {
      checks.push({ check_id: 'platform.diagnostics', status: 'UNKNOWN', summary: 'Could not reach the platform /diagnostics endpoint', evidence: { error: error instanceof Error ? error.message : String(error) } });
    }
  }

  if (deps.clientGateway) {
    try {
      const readiness = await deps.clientGateway.ready() as ClientGatewayReadiness;
      checks.push({
        check_id: 'client_gateway.readiness', status: readiness.ready ? 'PASS' : 'FAIL',
        summary: `Client gateway is ${readiness.status}${readiness.mode ? ` (mode=${readiness.mode})` : ''}`, evidence: readiness,
        ...(!readiness.ready ? { guidance: 'The client gateway cannot serve client onboarding/action requests until this recovers.' } : {}),
      });
      if (readiness.governed_execution === false) {
        checks.push({ check_id: 'client_gateway.governed_execution', status: 'WARN', summary: 'The client gateway is running in record-only mode — client actions are NOT governed', guidance: 'This must never be the case in production (see TNA-64). Verify CLIENT_GATEWAY_MODE and NODE_ENV.' });
      }
    } catch (error) {
      checks.push({ check_id: 'client_gateway.readiness', status: 'FAIL', summary: 'Could not reach the client gateway /ready endpoint', evidence: { error: error instanceof Error ? error.message : String(error) }, guidance: 'Verify the client gateway process is running and the configured clientGatewayUrl is correct.' });
    }
  }

  if (!deps.platform && !deps.clientGateway) {
    checks.push({ check_id: 'profile.endpoints', status: 'UNKNOWN', summary: 'This profile configures neither a platformUrl nor a clientGatewayUrl — nothing to check' });
  }

  const overall = checks.reduce<DiagnosticStatus>((acc, check) => worseOf(acc, check.status), 'PASS');
  return { overall, checks };
}

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Configuration for the Control Center BFF.
 * Same pattern as every prior app's `config.ts` — a single validated load from environment variables,
 * failing closed on anything missing.
 */

import type { ClientGatewayConfig } from './client-gateway-client.js';

export interface ControlCenterConfig {
  readonly dbPath: string;
  readonly tenantRegistryPath: string;
  readonly port: number;
  readonly host: string;
  readonly cookieSecure: boolean;
  /** Section 122: when set, this server also serves the ALREADY-BUILT (`vite build`) static frontend
   * from this directory — the packaged production shape. Never a dev server; this app never imports or
   * runs Vite itself. Optional so the BFF remains independently runnable/testable without the frontend
   * having been built first. */
  readonly staticRoot: string | null;
  /** Foundation-review item A: the real, accepted `apps/tna-client-gateway` admin API — ONE shared
   * base URL/token for the whole deployment (Client Gateway is genuinely multi-tenant, unlike Platform's
   * one-process-per-tenant model). This is what makes tenant lifecycle (ACTIVE/SUSPENDED/...) and
   * connections/tools/identity real rather than Control-Center-local. `null` only for pure Platform-only
   * test/dev configurations that predate this integration. */
  readonly clientGateway: ClientGatewayConfig | null;
  /** Section 72/build-order item 17: the real, operator-declared deployment environment — surfaced to the
   * browser via `/api/session/me` so the environment banner is real backend state, never a hardcoded
   * "DEVELOPMENT" string in the frontend regardless of where it is actually deployed. Fails closed to
   * `development` (the least-trusted-looking label) rather than defaulting to `production` when unset —
   * an operator who forgets to set this sees an intentionally alarming/incorrect-looking banner, not a
   * falsely reassuring one. */
  readonly environment: 'development' | 'staging' | 'production';
  /** Build-order item 10: explicit CORS allowlist — an exact-match origin, never a wildcard, and only ever
   * combined with `Access-Control-Allow-Credentials` for an origin on this list. Empty by default (no
   * cross-origin browser access at all beyond same-origin, which is the correct default for a
   * cookie-authenticated console with no legitimate cross-origin caller in v0.1). */
  readonly trustedOrigins: readonly string[];
}

export function loadControlCenterConfig(env: NodeJS.ProcessEnv = process.env): ControlCenterConfig {
  const dbPath = env.TNA_CONTROL_CENTER_DB_PATH ?? 'data/control-center.sqlite';
  const tenantRegistryPath = env.TNA_CONTROL_CENTER_TENANT_REGISTRY_PATH ?? '';
  if (tenantRegistryPath.length === 0) throw new Error('TNA_CONTROL_CENTER_TENANT_REGISTRY_PATH must be set');
  const portRaw = env.TNA_CONTROL_CENTER_PORT ?? '4719';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`TNA_CONTROL_CENTER_PORT must be a valid port number, got: ${portRaw}`);
  const host = env.TNA_CONTROL_CENTER_HOST ?? '127.0.0.1';
  const cookieSecure = env.TNA_CONTROL_CENTER_COOKIE_SECURE === 'true';
  const staticRoot = env.TNA_CONTROL_CENTER_STATIC_ROOT ?? null;
  const cgBaseUrl = env.TNA_CONTROL_CENTER_CLIENT_GATEWAY_URL ?? '';
  const cgToken = env.TNA_CONTROL_CENTER_CLIENT_GATEWAY_ADMIN_TOKEN ?? '';
  if ((cgBaseUrl.length > 0) !== (cgToken.length > 0)) throw new Error('TNA_CONTROL_CENTER_CLIENT_GATEWAY_URL and TNA_CONTROL_CENTER_CLIENT_GATEWAY_ADMIN_TOKEN must be set together');
  const clientGateway = cgBaseUrl.length > 0 ? { baseUrl: cgBaseUrl, adminToken: cgToken } : null;
  const envRaw = env.TNA_CONTROL_CENTER_ENVIRONMENT ?? 'development';
  if (envRaw !== 'development' && envRaw !== 'staging' && envRaw !== 'production') throw new Error(`TNA_CONTROL_CENTER_ENVIRONMENT must be development|staging|production, got: ${envRaw}`);
  const trustedOrigins = (env.TNA_CONTROL_CENTER_TRUSTED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(o => o.length > 0);
  return { dbPath, tenantRegistryPath, port, host, cookieSecure, staticRoot, clientGateway, environment: envRaw, trustedOrigins };
}

/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). Configuration for the client gateway app.
 * Follows the same pattern as `apps/tna-platform/src/config.ts` — a single validated load from
 * environment variables, failing closed on anything missing or insecure.
 *
 * Packaged-execution closure: adds `mode` (TNA-64 — the packaged production entrypoint must expose the
 * same choice between real governed execution and an explicitly-labeled non-governed recording mode
 * that the architecture claims, and must never silently prefer the weaker one). Production
 * (`NODE_ENV=production`) categorically rejects `record-only` at config-load time, before anything
 * durable is touched (section 15, 17, TNA-55) — there is no environment-dependent fallback path.
 */

export type ClientGatewayMode = 'governed' | 'record-only';

export interface ClientGatewayConfig {
  readonly adminToken: string;
  readonly dbPath: string;
  readonly dataDir: string;
  readonly port: number;
  readonly host: string;
  readonly nodeEnv: string;
  /** 'governed' (default): the production entrypoint must construct a real PlatformFacade and fail
   * startup if it cannot. 'record-only': client actions are only ever recorded, never executed through
   * Gate/Sentinel/MCP — provides no governed execution assurance whatsoever, and is refused outright
   * when `nodeEnv === 'production'`. */
  readonly mode: ClientGatewayMode;
}

function resolveMode(env: NodeJS.ProcessEnv, nodeEnv: string): ClientGatewayMode {
  const raw = env.CLIENT_GATEWAY_MODE ?? 'governed';
  if (raw !== 'governed' && raw !== 'record-only') {
    throw new Error(`CLIENT_GATEWAY_MODE must be "governed" or "record-only", got: ${raw}`);
  }
  if (raw === 'record-only' && nodeEnv === 'production') {
    throw new Error(
      'CLIENT_GATEWAY_MODE=record-only is refused when NODE_ENV=production — record-only mode provides ' +
      'no governed execution assurance (no Gate/Capability/Sentinel/MCP path) and must never be the ' +
      'production posture. Unset CLIENT_GATEWAY_MODE (or set it to "governed") for a production deployment.',
    );
  }
  return raw;
}

export function loadClientGatewayConfig(env: NodeJS.ProcessEnv = process.env): ClientGatewayConfig {
  const adminToken = env.TNA_CLIENT_ADMIN_TOKEN ?? '';
  if (adminToken.length < 32) {
    throw new Error('TNA_CLIENT_ADMIN_TOKEN must be set and at least 32 characters');
  }
  const dbPath = env.TNA_CLIENT_DB_PATH ?? 'data/client.sqlite';
  const dataDir = env.TNA_CLIENT_DATA_DIR ?? (dbPath.replace(/[/\\][^/\\]*$/, '') || 'data');
  const portRaw = env.TNA_CLIENT_PORT ?? '4318';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`TNA_CLIENT_PORT must be a valid port number, got: ${portRaw}`);
  }
  const host = env.TNA_CLIENT_HOST ?? '127.0.0.1';
  const nodeEnv = env.NODE_ENV ?? 'development';
  const mode = resolveMode(env, nodeEnv);
  return { adminToken, dbPath, dataDir, port, host, nodeEnv, mode };
}

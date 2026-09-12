/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Operator CLI configuration — a named
 * "profile" (section 82) referencing deployment endpoints and *environment-variable names* holding
 * bearer credentials, never a raw secret written to disk (section 12, 84). Profiles are plain JSON files
 * under `~/.tna/profiles/<name>.json` (or `TNA_OPERATOR_PROFILE_DIR`), selected via `--profile <name>`
 * or `TNA_OPERATOR_PROFILE`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { isOperatorRole, type OperatorRole } from './roles.js';

export interface OperatorProfile {
  readonly name: string;
  readonly role: OperatorRole;
  /** Section 81: explicit dev-mode opt-in — the only way a plain `http://` endpoint is accepted. */
  readonly devMode: boolean;
  readonly platformUrl?: string | undefined;
  readonly platformTokenEnv?: string | undefined;
  readonly clientGatewayUrl?: string | undefined;
  readonly clientGatewayAdminTokenEnv?: string | undefined;
}

export class OperatorConfigError extends Error {
  public constructor(message: string) { super(message); this.name = 'OperatorConfigError'; }
}

function profileDir(env: NodeJS.ProcessEnv): string {
  return env.TNA_OPERATOR_PROFILE_DIR ?? resolve(homedir(), '.tna', 'profiles');
}

/** Section 80: TLS is required for every non-dev-mode endpoint — a plain `http://` URL is refused
 * outright unless `devMode: true` was explicitly set in the profile. Never a silent downgrade. */
function assertEndpointSecurity(label: string, url: string, devMode: boolean): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new OperatorConfigError(`${label} is not a valid URL: ${url}`); }
  if (parsed.protocol !== 'https:' && !devMode) {
    throw new OperatorConfigError(
      `${label} (${url}) is not https:// and this profile does not set devMode:true — refusing to silently ` +
      'downgrade TLS verification for a production-shaped endpoint. Use an https:// URL, or set "devMode": true ' +
      'explicitly for a local development profile.',
    );
  }
}

export function loadOperatorProfile(profileName: string, env: NodeJS.ProcessEnv = process.env): OperatorProfile {
  const path = resolve(profileDir(env), `${profileName}.json`);
  if (!existsSync(path)) {
    throw new OperatorConfigError(`No such operator profile: "${profileName}" (expected ${path})`);
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) { throw new OperatorConfigError(`Profile ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new OperatorConfigError(`Profile ${path} must be a JSON object`);
  const obj = raw as Record<string, unknown>;
  if (!isOperatorRole(obj.role)) throw new OperatorConfigError(`Profile ${path}: "role" must be one of viewer|operator|security-operator|admin`);
  const devMode = obj.devMode === true;
  const platformUrl = typeof obj.platformUrl === 'string' ? obj.platformUrl : undefined;
  const clientGatewayUrl = typeof obj.clientGatewayUrl === 'string' ? obj.clientGatewayUrl : undefined;
  if (platformUrl) assertEndpointSecurity(`${profileName}.platformUrl`, platformUrl, devMode);
  if (clientGatewayUrl) assertEndpointSecurity(`${profileName}.clientGatewayUrl`, clientGatewayUrl, devMode);
  return {
    name: profileName, role: obj.role, devMode, platformUrl,
    platformTokenEnv: typeof obj.platformTokenEnv === 'string' ? obj.platformTokenEnv : undefined,
    clientGatewayUrl,
    clientGatewayAdminTokenEnv: typeof obj.clientGatewayAdminTokenEnv === 'string' ? obj.clientGatewayAdminTokenEnv : undefined,
  };
}

/** Resolves a profile's referenced credential from the environment — never from the profile file
 * itself, and never logged/echoed anywhere in this module. */
export function resolveCredential(envVarName: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!envVarName) throw new OperatorConfigError('This profile does not reference a credential environment variable for this subsystem');
  const value = env[envVarName];
  if (!value) throw new OperatorConfigError(`Environment variable ${envVarName} is not set`);
  return value;
}

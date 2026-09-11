import { resolve } from 'node:path';
import {
  loadDeploymentConfigFromEnv, resolveDeploymentSecrets, computeConfigHash,
  type DeploymentConfig, type ResolvedDeploymentSecrets,
} from '../../../packages/deployment-schema/src/index.js';

/**
 * TNA Deployment Engineering v0.1 (Volume 9). The single place `apps/tna-platform` loads and validates
 * its own configuration — replaces the ad hoc `process.env[name] ?? ''` reads Volume 8's `main.ts`
 * used, with the strict, fail-closed `DeploymentConfig` loader from `deployment-schema` (section 15,
 * 17, TNA-55: "Configuration is executable authority"). Startup throws on anything invalid; it never
 * falls back to an insecure default.
 */
export interface AppConfig {
  readonly deployment: DeploymentConfig;
  readonly secrets: ResolvedDeploymentSecrets;
  readonly configHash: string;
  readonly dataDir: string;
  /** Present only when environment !== 'production' and no capability_key_ref was configured —
   * matches Volume 8's original behavior of a random in-memory key for local/dev/test runs. */
  readonly ephemeralCapabilityKey: boolean;
}

export function loadAppConfig(root: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const deployment = loadDeploymentConfigFromEnv(env);
  const secrets = resolveDeploymentSecretsWithDevFallback(deployment, env);
  const configHash = computeConfigHash(deployment);
  const dataDir = resolve(root, deployment.storage.data_dir);
  return { deployment, secrets: secrets.resolved, configHash, dataDir, ephemeralCapabilityKey: secrets.ephemeralCapabilityKey };
}

/** In development/test, an absent `capability_key_ref` is allowed (Volume 8's original ergonomics for
 * local runs) — `resolveDeploymentSecrets` still resolves the three bearer tokens strictly in every
 * environment; it only special-cases the *optional* capability key outside production. */
function resolveDeploymentSecretsWithDevFallback(deployment: DeploymentConfig, env: NodeJS.ProcessEnv): { resolved: ResolvedDeploymentSecrets; ephemeralCapabilityKey: boolean } {
  const resolved = resolveDeploymentSecrets(deployment, env);
  return { resolved, ephemeralCapabilityKey: resolved.capabilityKey === null };
}

import { readFileSync } from 'node:fs';
import { ControlCenterError, type TenantRegistryEntry } from './schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), section 3/64/65. Every real TNA deployment is
 * one tenant's own `apps/tna-platform` instance (the same single-tenant-per-process convention already
 * established across every prior accepted backend app in this project) — the Control Center is the first
 * app that talks to MORE THAN ONE tenant's backend from a single process, so it needs a real mapping from
 * tenant id to that tenant's own backend base URL and service token. This registry is trusted, operator
 * -provisioned configuration (a JSON file), never derived from anything a browser sends.
 *
 * Foundation-review section 9 (tenant identity): tenant ids are treated as opaque, case-SENSITIVE byte
 * strings — no normalization (case-folding, trimming, Unicode normalization) is applied anywhere in this
 * module or in `ControlCenterSessionStore` (which stores a user's `tenant_id` verbatim). `"Tenant-A"`,
 * `"tenant-a"`, and `"TENANT-A"` are three distinct, non-colliding tenant identities by construction — a
 * plain JS `Map<string, ...>` keyed on the literal string, and SQLite's default case-sensitive `TEXT`
 * comparison, agree on this without any extra code. A DUPLICATE tenant_id within one registry (the same
 * id appearing twice) is treated as a configuration error and REJECTED at load time — never silently
 * last-write-wins, which could otherwise let a misconfigured registry entry silently redirect an existing
 * tenant's traffic to the wrong backend.
 */

export interface TenantRegistry {
  readonly entryFor: (tenantId: string) => TenantRegistryEntry | null;
}

export function loadTenantRegistry(path: string): TenantRegistry {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { throw new ControlCenterError('CONFIG_ERROR', `Could not read tenant registry at ${path}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ControlCenterError('CONFIG_ERROR', `Tenant registry at ${path} is not valid JSON`); }
  if (!Array.isArray(parsed)) throw new ControlCenterError('CONFIG_ERROR', 'Tenant registry must be a JSON array of entries');
  const entries = new Map<string, TenantRegistryEntry>();
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) throw new ControlCenterError('CONFIG_ERROR', 'Tenant registry entry must be an object');
    const e = entry as Record<string, unknown>;
    if (typeof e.tenant_id !== 'string' || e.tenant_id.length === 0) throw new ControlCenterError('CONFIG_ERROR', 'Tenant registry entry missing tenant_id');
    if (typeof e.platform_base_url !== 'string' || !e.platform_base_url.startsWith('http')) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} missing a valid platform_base_url`);
    if (typeof e.platform_token !== 'string' || e.platform_token.length < 32) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} missing a platform_token of at least 32 characters`);
    if (typeof e.platform_operator_token !== 'string' || e.platform_operator_token.length < 32) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} missing a platform_operator_token of at least 32 characters`);
    if (e.status !== undefined && e.status !== 'ACTIVE' && e.status !== 'SUSPENDED') throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} has an invalid status: ${String(e.status)}`);
    if (e.ledger_base_url !== undefined && (typeof e.ledger_base_url !== 'string' || !e.ledger_base_url.startsWith('http'))) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} has an invalid ledger_base_url`);
    if (e.ledger_reader_token !== undefined && (typeof e.ledger_reader_token !== 'string' || e.ledger_reader_token.length < 32)) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} has an invalid ledger_reader_token`);
    if (e.ledger_admin_token !== undefined && (typeof e.ledger_admin_token !== 'string' || e.ledger_admin_token.length < 32)) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} has an invalid ledger_admin_token`);
    if (e.auditor_base_url !== undefined && (typeof e.auditor_base_url !== 'string' || !e.auditor_base_url.startsWith('http'))) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} has an invalid auditor_base_url`);
    if (e.auditor_token !== undefined && (typeof e.auditor_token !== 'string' || e.auditor_token.length < 32)) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} has an invalid auditor_token`);
    if (e.improvement_base_url !== undefined && (typeof e.improvement_base_url !== 'string' || !e.improvement_base_url.startsWith('http'))) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} has an invalid improvement_base_url`);
    if (e.improvement_admin_token !== undefined && (typeof e.improvement_admin_token !== 'string' || e.improvement_admin_token.length < 32)) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry entry ${e.tenant_id} has an invalid improvement_admin_token`);
    if (entries.has(e.tenant_id)) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry contains a duplicate tenant_id: ${e.tenant_id} — this is a configuration error, never silently last-write-wins`);
    entries.set(e.tenant_id, {
      tenant_id: e.tenant_id, platform_base_url: e.platform_base_url, platform_token: e.platform_token, platform_operator_token: e.platform_operator_token,
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.ledger_base_url !== undefined ? { ledger_base_url: e.ledger_base_url } : {}),
      ...(e.ledger_reader_token !== undefined ? { ledger_reader_token: e.ledger_reader_token } : {}),
      ...(e.ledger_admin_token !== undefined ? { ledger_admin_token: e.ledger_admin_token } : {}),
      ...(e.auditor_base_url !== undefined ? { auditor_base_url: e.auditor_base_url } : {}),
      ...(e.auditor_token !== undefined ? { auditor_token: e.auditor_token } : {}),
      ...(e.improvement_base_url !== undefined ? { improvement_base_url: e.improvement_base_url } : {}),
      ...(e.improvement_admin_token !== undefined ? { improvement_admin_token: e.improvement_admin_token } : {}),
    });
  }
  return { entryFor: (tenantId: string) => entries.get(tenantId) ?? null };
}

export function tenantRegistryFromEntries(entries: readonly TenantRegistryEntry[]): TenantRegistry {
  const map = new Map<string, TenantRegistryEntry>();
  for (const e of entries) {
    if (map.has(e.tenant_id)) throw new ControlCenterError('CONFIG_ERROR', `Tenant registry contains a duplicate tenant_id: ${e.tenant_id}`);
    map.set(e.tenant_id, e);
  }
  return { entryFor: (tenantId: string) => map.get(tenantId) ?? null };
}

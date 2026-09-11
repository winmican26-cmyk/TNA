import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  ClientError, canonical, hash as hashValue, newTenantId, newServiceId, issueCredential, hashCredentialToken,
  verifyCredentialToken, readPageOptions, type ClientTenant, type ClientTenantStatus, type ClientTenantCreateInput,
  type ClientServiceIdentity, type ClientServiceIdentityCreateInput, type IssuedCredential, type Page,
} from '../../client-schema/src/index.js';
import {
  McpError, hashConfig, newToolId, toolPlatformId, MAX_MCP_SERVERS_PER_TENANT, MAX_TOOLS_PER_SERVER,
  type McpServerRegistration, type McpServerRegisterInput, type GovernedToolDefinition, type ToolReviewStatus,
  type DiscoveredMcpTool,
} from '../../mcp-schema/src/index.js';

/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). Durable SQLite store for the client-onboarding
 * control plane: tenants, service identities, MCP server registrations, governed tools, and policy
 * bindings. Every mutation of race-sensitive state is a `state_version` compare-and-swap (section 100)
 * — the same TNA-33 discipline every prior volume's own durable store applies. Every query is
 * tenant-scoped; there is no method anywhere in this class that accepts an unscoped identifier and
 * returns cross-tenant data (section 38).
 */

export interface ToolPolicyBinding {
  readonly binding_id: string;
  readonly tenant_id: string;
  readonly tool_id: string;
  readonly policy_id: string;
  readonly policy_hash: string;
  readonly risk_class: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly approval_mode: 'none' | 'human_approval';
  readonly runtime_limits: Readonly<Record<string, unknown>>;
  readonly cost_limits: Readonly<Record<string, unknown>>;
  readonly verification_requirement: 'none' | 'vad';
  readonly bound_at: string;
  readonly bound_by: string;
}

export interface ClientActionRecord {
  readonly tenant_id: string;
  readonly client_action_id: string;
  readonly service_id: string;
  readonly mcp_server_id: string | null;
  readonly governed_tool_id: string | null;
  readonly config_snapshot_hash: string;
  readonly created_at: string;
}

interface TenantRow {
  tenant_id: string; display_name: string; environment: string; status: string; created_at: string; created_by: string;
  deployment_binding: string; policy_profile: string; allowed_connector_types_json: string; configuration_hash: string;
  state_version: number; suspended_reason: string | null; offboarding_reason: string | null;
}
function rowToTenant(row: TenantRow): ClientTenant {
  return {
    tenant_id: row.tenant_id, display_name: row.display_name, environment: row.environment as ClientTenant['environment'],
    status: row.status as ClientTenantStatus, created_at: row.created_at, created_by: row.created_by,
    deployment_binding: row.deployment_binding, policy_profile: row.policy_profile,
    allowed_connector_types: JSON.parse(row.allowed_connector_types_json) as readonly 'mcp-stdio'[],
    configuration_hash: row.configuration_hash, state_version: row.state_version,
    suspended_reason: row.suspended_reason, offboarding_reason: row.offboarding_reason,
  };
}
interface ServiceRow {
  service_id: string; tenant_id: string; name: string; role: string; status: string; credential_hash: string;
  credential_ref: string; created_at: string; last_rotated_at: string; state_version: number;
}
function rowToService(row: ServiceRow): ClientServiceIdentity {
  return {
    service_id: row.service_id, tenant_id: row.tenant_id, name: row.name, role: row.role as ClientServiceIdentity['role'],
    status: row.status as ClientServiceIdentity['status'], credential_ref: row.credential_ref,
    created_at: row.created_at, last_rotated_at: row.last_rotated_at, state_version: row.state_version,
  };
}
interface McpServerRow {
  mcp_server_id: string; tenant_id: string; name: string; transport: string; executable: string; args_json: string;
  env_allowlist_json: string; credential_ref: string | null; status: string; created_at: string; config_hash: string; state_version: number;
}
function rowToMcpServer(row: McpServerRow): McpServerRegistration {
  return {
    mcp_server_id: row.mcp_server_id, tenant_id: row.tenant_id, name: row.name, transport: 'stdio',
    executable: row.executable, args: JSON.parse(row.args_json) as readonly string[],
    env_allowlist: JSON.parse(row.env_allowlist_json) as readonly string[], credential_ref: row.credential_ref,
    status: row.status as McpServerRegistration['status'], created_at: row.created_at, config_hash: row.config_hash,
    state_version: row.state_version,
  };
}
interface ToolRow {
  tenant_id: string; tool_id: string; provider_type: string; provider_id: string; external_tool_name: string;
  description: string; input_schema_json: string; schema_hash: string; risk_class: string | null;
  allowed_operations_json: string; resource_patterns_json: string; enabled: number; requires_human_approval: number;
  requires_vad: number; review_status: string; created_at: string; updated_at: string; state_version: number;
}
function rowToTool(row: ToolRow): GovernedToolDefinition {
  return {
    tenant_id: row.tenant_id, tool_id: row.tool_id, provider_type: 'mcp', provider_id: row.provider_id,
    external_tool_name: row.external_tool_name, description: row.description,
    input_schema: JSON.parse(row.input_schema_json), schema_hash: row.schema_hash,
    risk_class: row.risk_class as GovernedToolDefinition['risk_class'],
    allowed_operations: JSON.parse(row.allowed_operations_json) as readonly string[],
    resource_patterns: JSON.parse(row.resource_patterns_json) as readonly string[],
    enabled: row.enabled === 1, requires_human_approval: row.requires_human_approval === 1, requires_vad: row.requires_vad === 1,
    review_status: row.review_status as ToolReviewStatus, created_at: row.created_at, updated_at: row.updated_at, state_version: row.state_version,
  };
}

export class ClientStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  public constructor(path: string, options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS client_tenants (
        tenant_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, environment TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, created_by TEXT NOT NULL, deployment_binding TEXT NOT NULL, policy_profile TEXT NOT NULL,
        allowed_connector_types_json TEXT NOT NULL, configuration_hash TEXT NOT NULL, state_version INTEGER NOT NULL,
        suspended_reason TEXT, offboarding_reason TEXT);
      CREATE TABLE IF NOT EXISTS client_service_identities (
        service_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE, credential_ref TEXT NOT NULL, created_at TEXT NOT NULL,
        last_rotated_at TEXT NOT NULL, state_version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS client_service_identities_tenant ON client_service_identities(tenant_id);
      CREATE TABLE IF NOT EXISTS mcp_servers (
        mcp_server_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL,
        executable TEXT NOT NULL, args_json TEXT NOT NULL, env_allowlist_json TEXT NOT NULL, credential_ref TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, config_hash TEXT NOT NULL, state_version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_servers_tenant ON mcp_servers(tenant_id);
      CREATE TABLE IF NOT EXISTS governed_tools (
        tenant_id TEXT NOT NULL, tool_id TEXT NOT NULL, provider_type TEXT NOT NULL, provider_id TEXT NOT NULL,
        external_tool_name TEXT NOT NULL, description TEXT NOT NULL, input_schema_json TEXT NOT NULL, schema_hash TEXT NOT NULL,
        risk_class TEXT, allowed_operations_json TEXT NOT NULL, resource_patterns_json TEXT NOT NULL,
        enabled INTEGER NOT NULL, requires_human_approval INTEGER NOT NULL, requires_vad INTEGER NOT NULL,
        review_status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, state_version INTEGER NOT NULL,
        PRIMARY KEY(tenant_id, tool_id));
      CREATE INDEX IF NOT EXISTS governed_tools_provider ON governed_tools(tenant_id, provider_id);
      CREATE TABLE IF NOT EXISTS tool_policy_bindings (
        binding_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, tool_id TEXT NOT NULL, policy_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL, risk_class TEXT NOT NULL, approval_mode TEXT NOT NULL, runtime_limits_json TEXT NOT NULL,
        cost_limits_json TEXT NOT NULL, verification_requirement TEXT NOT NULL, bound_at TEXT NOT NULL, bound_by TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tool_policy_bindings_tool ON tool_policy_bindings(tenant_id, tool_id, bound_at);
      CREATE TABLE IF NOT EXISTS client_actions (
        tenant_id TEXT NOT NULL, client_action_id TEXT NOT NULL, service_id TEXT NOT NULL, mcp_server_id TEXT,
        governed_tool_id TEXT, config_snapshot_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, client_action_id));
    `);
    this.recoverInterruptedWork();
  }
  public close(): void { this.db.close(); }
  private now(): string { return new Date(this.clock()).toISOString(); }
  private tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* not open */ } throw error; } }

  /** Nothing about this store's own state has an "interrupted" mid-flight shape that requires recovery
   * beyond ordinary CAS — every mutation here is a single atomic UPDATE/INSERT, not a multi-step
   * durable workflow like the platform's outbox. Reserved for symmetry with every other TNA store's own
   * constructor-time self-check discipline; a future migration that does add multi-step state belongs here. */
  private recoverInterruptedWork(): void { /* no-op by design — see comment above */ }

  // -----------------------------------------------------------------------------------------
  // Tenants (section 4-5, 10, 52, 54)
  // -----------------------------------------------------------------------------------------

  public createTenant(input: ClientTenantCreateInput, createdBy: string): ClientTenant {
    const now = this.now();
    const tenantId = newTenantId();
    const configHash = hashValue({ display_name: input.display_name, environment: input.environment, deployment_binding: input.deployment_binding, policy_profile: input.policy_profile, allowed_connector_types: input.allowed_connector_types });
    return this.tx(() => {
      this.db.prepare('INSERT INTO client_tenants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        tenantId, input.display_name, input.environment, 'PENDING', now, createdBy, input.deployment_binding,
        input.policy_profile, JSON.stringify(input.allowed_connector_types), configHash, 0, null, null,
      );
      return this.getTenant(tenantId);
    });
  }
  public getTenant(tenantId: string): ClientTenant {
    const row = this.db.prepare('SELECT * FROM client_tenants WHERE tenant_id=?').get(tenantId) as unknown as TenantRow | undefined;
    if (!row) throw new ClientError('NOT_FOUND', `No tenant ${tenantId}`);
    return rowToTenant(row);
  }
  public listTenants(options: { limit?: number; cursor?: string } = {}): Page<ClientTenant> {
    const limit = readPageOptions(options.limit);
    const offset = options.cursor ? Number(Buffer.from(options.cursor, 'base64url').toString('utf8')) : 0;
    const rows = this.db.prepare('SELECT * FROM client_tenants ORDER BY created_at, tenant_id LIMIT ? OFFSET ?').all(limit + 1, offset) as unknown as TenantRow[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).map(rowToTenant), ...(hasMore ? { nextCursor: Buffer.from(String(offset + limit)).toString('base64url') } : {}) };
  }
  /** The actual CAS transition — no transaction of its own, since `beginOffboarding` must run this
   * inside the same transaction as its own cascade (SQLite has no nested transactions: starting a
   * second `BEGIN` inside an already-open one is a hard error, not a no-op). Standalone callers use the
   * public `transitionTenant` wrapper below, which supplies the transaction boundary. */
  private transitionTenantInTx(tenantId: string, expectedVersion: number, allowedFrom: readonly ClientTenantStatus[], target: ClientTenantStatus, extra?: { suspended_reason?: string | null; offboarding_reason?: string | null }): ClientTenant {
    const current = this.getTenant(tenantId);
    if (current.state_version !== expectedVersion) throw new ClientError('CONFLICT', 'Tenant state has changed — retry with the current version');
    if (!allowedFrom.includes(current.status)) throw new ClientError('CONFLICT', `Tenant cannot move to ${target} from ${current.status}`);
    const suspendedReason = extra && 'suspended_reason' in extra ? extra.suspended_reason ?? null : current.suspended_reason;
    const offboardingReason = extra && 'offboarding_reason' in extra ? extra.offboarding_reason ?? null : current.offboarding_reason;
    const changed = this.db.prepare('UPDATE client_tenants SET status=?, state_version=state_version+1, suspended_reason=?, offboarding_reason=? WHERE tenant_id=? AND state_version=?')
      .run(target, suspendedReason, offboardingReason, tenantId, expectedVersion);
    if (changed.changes !== 1) throw new ClientError('CONFLICT', 'Tenant state changed concurrently');
    return this.getTenant(tenantId);
  }
  private transitionTenant(tenantId: string, expectedVersion: number, allowedFrom: readonly ClientTenantStatus[], target: ClientTenantStatus, extra?: { suspended_reason?: string | null; offboarding_reason?: string | null }): ClientTenant {
    return this.tx(() => this.transitionTenantInTx(tenantId, expectedVersion, allowedFrom, target, extra));
  }
  public activateTenant(tenantId: string, expectedVersion: number): ClientTenant { return this.transitionTenant(tenantId, expectedVersion, ['PENDING'], 'ACTIVE', { suspended_reason: null }); }
  public suspendTenant(tenantId: string, expectedVersion: number, reason: string): ClientTenant { return this.transitionTenant(tenantId, expectedVersion, ['ACTIVE'], 'SUSPENDED', { suspended_reason: reason }); }
  public resumeTenant(tenantId: string, expectedVersion: number): ClientTenant { return this.transitionTenant(tenantId, expectedVersion, ['SUSPENDED'], 'ACTIVE', { suspended_reason: null }); }

  /** Section 9, 52: begins offboarding and cascades revocation immediately, in the same transaction —
   * service identities revoked, enabled tools disabled, MCP servers disabled. Historical Ledger
   * evidence and this store's own historical rows are never deleted (section 9: "Do not delete
   * historical Ledger evidence merely because the tenant is offboarded"). */
  public beginOffboarding(tenantId: string, expectedVersion: number, reason: string, actor: string): ClientTenant {
    return this.tx(() => {
      const tenant = this.transitionTenantInTx(tenantId, expectedVersion, ['ACTIVE', 'SUSPENDED'], 'OFFBOARDING', { offboarding_reason: reason });
      const now = this.now();
      this.db.prepare("UPDATE client_service_identities SET status='REVOKED', state_version=state_version+1 WHERE tenant_id=? AND status='ACTIVE'").run(tenantId);
      this.db.prepare("UPDATE governed_tools SET enabled=0, review_status='DISABLED', updated_at=?, state_version=state_version+1 WHERE tenant_id=? AND enabled=1").run(now, tenantId);
      this.db.prepare("UPDATE mcp_servers SET status='DISABLED', state_version=state_version+1 WHERE tenant_id=? AND status!='DISABLED'").run(tenantId);
      void actor;
      return tenant;
    });
  }
  public completeOffboarding(tenantId: string, expectedVersion: number): ClientTenant { return this.transitionTenant(tenantId, expectedVersion, ['OFFBOARDING'], 'OFFBOARDED'); }

  public assertActionEligible(tenantId: string): ClientTenant {
    const tenant = this.getTenant(tenantId);
    if (tenant.status !== 'ACTIVE') throw new ClientError('TENANT_NOT_ACTIVE', `Tenant ${tenantId} is ${tenant.status} — new consequential actions are refused`);
    return tenant;
  }

  // -----------------------------------------------------------------------------------------
  // Service identities (section 6-8, 55)
  // -----------------------------------------------------------------------------------------

  public createServiceIdentity(tenantId: string, input: ClientServiceIdentityCreateInput, _createdBy: string): { identity: ClientServiceIdentity; credential: IssuedCredential } {
    void _createdBy;
    return this.tx(() => {
      this.assertActionEligible2(tenantId);
      const now = this.now();
      const serviceId = newServiceId();
      const credential = issueCredential();
      const credentialHash = hashCredentialToken(credential.token);
      this.db.prepare('INSERT INTO client_service_identities VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        serviceId, tenantId, input.name, input.role, 'ACTIVE', credentialHash, credential.credential_ref, now, now, 0,
      );
      return { identity: this.getServiceIdentity(tenantId, serviceId), credential };
    });
  }
  /** Section 4/10 nuance: service identities may still be created for a PENDING tenant (onboarding is
   * in progress) but never for a SUSPENDED/OFFBOARDING/OFFBOARDED one. */
  private assertActionEligible2(tenantId: string): void {
    const tenant = this.getTenant(tenantId);
    if (tenant.status === 'SUSPENDED' || tenant.status === 'OFFBOARDING' || tenant.status === 'OFFBOARDED') {
      throw new ClientError('TENANT_NOT_ACTIVE', `Tenant ${tenantId} is ${tenant.status} — onboarding changes are refused`);
    }
  }
  public getServiceIdentity(tenantId: string, serviceId: string): ClientServiceIdentity {
    const row = this.db.prepare('SELECT * FROM client_service_identities WHERE tenant_id=? AND service_id=?').get(tenantId, serviceId) as unknown as ServiceRow | undefined;
    if (!row) throw new ClientError('NOT_FOUND', `No service identity ${serviceId}`);
    return rowToService(row);
  }
  public listServiceIdentities(tenantId: string, options: { limit?: number; cursor?: string } = {}): Page<ClientServiceIdentity> {
    const limit = readPageOptions(options.limit);
    const offset = options.cursor ? Number(Buffer.from(options.cursor, 'base64url').toString('utf8')) : 0;
    const rows = this.db.prepare('SELECT * FROM client_service_identities WHERE tenant_id=? ORDER BY created_at, service_id LIMIT ? OFFSET ?').all(tenantId, limit + 1, offset) as unknown as ServiceRow[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).map(rowToService), ...(hasMore ? { nextCursor: Buffer.from(String(offset + limit)).toString('base64url') } : {}) };
  }
  /** Section 56: rotation is one atomic UPDATE — the old credential's hash stops matching any row in
   * the same instant the new one starts matching, with no dual-valid window. */
  public rotateCredential(tenantId: string, serviceId: string, expectedVersion: number): { identity: ClientServiceIdentity; credential: IssuedCredential } {
    return this.tx(() => {
      const current = this.getServiceIdentity(tenantId, serviceId);
      if (current.state_version !== expectedVersion) throw new ClientError('CONFLICT', 'Service identity state has changed — retry with the current version');
      if (current.status !== 'ACTIVE') throw new ClientError('SERVICE_IDENTITY_REVOKED', 'Cannot rotate credentials for a revoked service identity');
      const now = this.now();
      const credential = issueCredential();
      const credentialHash = hashCredentialToken(credential.token);
      const changed = this.db.prepare('UPDATE client_service_identities SET credential_hash=?, credential_ref=?, last_rotated_at=?, state_version=state_version+1 WHERE tenant_id=? AND service_id=? AND state_version=?')
        .run(credentialHash, credential.credential_ref, now, tenantId, serviceId, expectedVersion);
      if (changed.changes !== 1) throw new ClientError('CONFLICT', 'Service identity changed concurrently');
      return { identity: this.getServiceIdentity(tenantId, serviceId), credential };
    });
  }
  public revokeServiceIdentity(tenantId: string, serviceId: string, expectedVersion: number): ClientServiceIdentity {
    return this.tx(() => {
      const current = this.getServiceIdentity(tenantId, serviceId);
      if (current.state_version !== expectedVersion) throw new ClientError('CONFLICT', 'Service identity state has changed — retry with the current version');
      const changed = this.db.prepare("UPDATE client_service_identities SET status='REVOKED', state_version=state_version+1 WHERE tenant_id=? AND service_id=? AND state_version=?").run(tenantId, serviceId, expectedVersion);
      if (changed.changes !== 1) throw new ClientError('CONFLICT', 'Service identity changed concurrently');
      return this.getServiceIdentity(tenantId, serviceId);
    });
  }
  /** Authenticates a bearer token to exactly one active service identity — the identity's own
   * `tenant_id`/`role` are the only source of authority; a caller-supplied tenant_id in a request body
   * is never trusted (section 37). */
  public authenticateService(token: string): ClientServiceIdentity | null {
    const hashHex = hashCredentialToken(token);
    const row = this.db.prepare('SELECT * FROM client_service_identities WHERE credential_hash=?').get(hashHex) as unknown as ServiceRow | undefined;
    if (!row) return null;
    if (row.status !== 'ACTIVE') return null;
    if (!verifyCredentialToken(token, row.credential_hash)) return null;
    return rowToService(row);
  }

  // -----------------------------------------------------------------------------------------
  // MCP server registration (section 13, 20)
  // -----------------------------------------------------------------------------------------

  public registerMcpServer(tenantId: string, input: McpServerRegisterInput, _createdBy: string): McpServerRegistration {
    void _createdBy;
    return this.tx(() => {
      this.assertActionEligible2(tenantId);
      const existingCount = (this.db.prepare('SELECT COUNT(*) AS n FROM mcp_servers WHERE tenant_id=?').get(tenantId) as { n: number }).n;
      if (existingCount >= MAX_MCP_SERVERS_PER_TENANT) throw new McpError('MCP_PROTOCOL_ERROR', `Tenant already has the maximum of ${MAX_MCP_SERVERS_PER_TENANT} MCP servers registered`);
      const now = this.now();
      const serverId = `mcps_${randomUUID()}`;
      const configHash = hashConfig({ name: input.name, transport: input.transport, executable: input.executable, args: input.args, env_allowlist: input.env_allowlist });
      this.db.prepare('INSERT INTO mcp_servers VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        serverId, tenantId, input.name, input.transport, input.executable, JSON.stringify(input.args),
        JSON.stringify(input.env_allowlist), input.credential_ref, 'REGISTERED', now, configHash, 0,
      );
      return this.getMcpServer(tenantId, serverId);
    });
  }
  public getMcpServer(tenantId: string, serverId: string): McpServerRegistration {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE tenant_id=? AND mcp_server_id=?').get(tenantId, serverId) as unknown as McpServerRow | undefined;
    if (!row) throw new ClientError('NOT_FOUND', `No MCP server ${serverId}`);
    return rowToMcpServer(row);
  }
  public listMcpServers(tenantId: string): readonly McpServerRegistration[] {
    return (this.db.prepare('SELECT * FROM mcp_servers WHERE tenant_id=? ORDER BY created_at').all(tenantId) as unknown as McpServerRow[]).map(rowToMcpServer);
  }
  public setMcpServerStatus(tenantId: string, serverId: string, expectedVersion: number, status: McpServerRegistration['status']): McpServerRegistration {
    return this.tx(() => {
      const changed = this.db.prepare('UPDATE mcp_servers SET status=?, state_version=state_version+1 WHERE tenant_id=? AND mcp_server_id=? AND state_version=?').run(status, tenantId, serverId, expectedVersion);
      if (changed.changes !== 1) throw new ClientError('CONFLICT', 'MCP server state changed concurrently');
      return this.getMcpServer(tenantId, serverId);
    });
  }
  /** Section 20: an explicit, trusted re-registration — never a silent in-place command/arg/env change.
   * Bumps `config_hash` and forces every tool bound to this server back into review (never inherits
   * prior trust under new startup configuration). */
  public reconfigureMcpServer(tenantId: string, serverId: string, expectedVersion: number, input: McpServerRegisterInput): McpServerRegistration {
    return this.tx(() => {
      const current = this.getMcpServer(tenantId, serverId);
      if (current.state_version !== expectedVersion) throw new ClientError('CONFLICT', 'MCP server state has changed — retry with the current version');
      const configHash = hashConfig({ name: input.name, transport: input.transport, executable: input.executable, args: input.args, env_allowlist: input.env_allowlist });
      const now = this.now();
      const changed = this.db.prepare('UPDATE mcp_servers SET name=?, executable=?, args_json=?, env_allowlist_json=?, credential_ref=?, status=?, config_hash=?, state_version=state_version+1 WHERE tenant_id=? AND mcp_server_id=? AND state_version=?')
        .run(input.name, input.executable, JSON.stringify(input.args), JSON.stringify(input.env_allowlist), input.credential_ref, 'REGISTERED', configHash, tenantId, serverId, expectedVersion);
      if (changed.changes !== 1) throw new ClientError('CONFLICT', 'MCP server changed concurrently');
      this.db.prepare("UPDATE governed_tools SET enabled=0, review_status='POLICY_REVIEW_REQUIRED', updated_at=?, state_version=state_version+1 WHERE tenant_id=? AND provider_id=? AND enabled=1").run(now, tenantId, serverId);
      return this.getMcpServer(tenantId, serverId);
    });
  }

  // -----------------------------------------------------------------------------------------
  // Governed tools / discovery (section 15-20, 59-61)
  // -----------------------------------------------------------------------------------------

  public getTool(tenantId: string, toolId: string): GovernedToolDefinition {
    const row = this.db.prepare('SELECT * FROM governed_tools WHERE tenant_id=? AND tool_id=?').get(tenantId, toolId) as unknown as ToolRow | undefined;
    if (!row) throw new ClientError('NOT_FOUND', `No governed tool ${toolId}`);
    return rowToTool(row);
  }
  public listTools(tenantId: string, serverId?: string): readonly GovernedToolDefinition[] {
    const rows = serverId
      ? this.db.prepare('SELECT * FROM governed_tools WHERE tenant_id=? AND provider_id=? ORDER BY created_at').all(tenantId, serverId) as unknown as ToolRow[]
      : this.db.prepare('SELECT * FROM governed_tools WHERE tenant_id=? ORDER BY created_at').all(tenantId) as unknown as ToolRow[];
    return rows.map(rowToTool);
  }

  /**
   * Section 15-20: discovery reconciliation. `discovered` is the full, current tool list a live MCP
   * `tools/list` call just returned for this server. New tools become `DISCOVERED` (never
   * auto-`ENABLED` — section 16, 61). A tool whose `schema_hash` changed from what was last known is
   * marked `POLICY_REVIEW_REQUIRED` and disabled (section 18-19, 58-59) — even if it was previously
   * `ENABLED`. A previously-known tool absent from this round is marked `REMOVED` and disabled
   * (section 60) — never left executable as a "ghost" registration.
   */
  public recordDiscovery(tenantId: string, serverId: string, discovered: readonly DiscoveredMcpTool[], schemaHash: (schema: unknown) => string): {
    readonly created: readonly string[]; readonly driftDetected: readonly string[]; readonly removed: readonly string[];
  } {
    if (discovered.length > MAX_TOOLS_PER_SERVER) throw new McpError('MCP_PROTOCOL_ERROR', `MCP server advertised ${discovered.length} tools, exceeding the ${MAX_TOOLS_PER_SERVER} bound`);
    return this.tx(() => {
      const now = this.now();
      const existing = this.db.prepare('SELECT * FROM governed_tools WHERE tenant_id=? AND provider_id=?').all(tenantId, serverId) as unknown as ToolRow[];
      const existingByName = new Map(existing.map(row => [row.external_tool_name, row]));
      const seenNames = new Set<string>();
      const created: string[] = []; const driftDetected: string[] = []; const removed: string[] = [];

      for (const tool of discovered) {
        seenNames.add(tool.name);
        const newHash = schemaHash(tool.input_schema);
        const existingRow = existingByName.get(tool.name);
        if (!existingRow) {
          const toolId = newToolId();
          this.db.prepare('INSERT INTO governed_tools VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
            tenantId, toolId, 'mcp', serverId, tool.name, tool.description, JSON.stringify(tool.input_schema), newHash,
            null, JSON.stringify([]), JSON.stringify([]), 0, 0, 0, 'DISCOVERED', now, now, 0,
          );
          created.push(toolId);
          continue;
        }
        if (existingRow.schema_hash !== newHash) {
          this.db.prepare("UPDATE governed_tools SET input_schema_json=?, schema_hash=?, description=?, enabled=0, review_status='POLICY_REVIEW_REQUIRED', updated_at=?, state_version=state_version+1 WHERE tenant_id=? AND tool_id=?")
            .run(JSON.stringify(tool.input_schema), newHash, tool.description, now, tenantId, existingRow.tool_id);
          driftDetected.push(existingRow.tool_id);
        }
      }
      for (const row of existing) {
        if (!seenNames.has(row.external_tool_name) && row.review_status !== 'REMOVED') {
          this.db.prepare("UPDATE governed_tools SET enabled=0, review_status='REMOVED', updated_at=?, state_version=state_version+1 WHERE tenant_id=? AND tool_id=?").run(now, tenantId, row.tool_id);
          removed.push(row.tool_id);
        }
      }
      this.setMcpServerStatusInTx(tenantId, serverId, 'REACHABLE');
      return { created, driftDetected, removed };
    });
  }
  private setMcpServerStatusInTx(tenantId: string, serverId: string, status: McpServerRegistration['status']): void {
    this.db.prepare('UPDATE mcp_servers SET status=?, state_version=state_version+1 WHERE tenant_id=? AND mcp_server_id=?').run(status, tenantId, serverId);
  }

  /** Section 32-34: trusted-operator-only. A client cannot reach this method — only the admin API
   * surface calls it, and only with an explicit, operator-supplied `risk_class`/approval/verification
   * decision (section 105: "No self-classification"). */
  public enableTool(tenantId: string, toolId: string, expectedVersion: number, decision: {
    readonly risk_class: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; readonly allowed_operations: readonly string[]; readonly resource_patterns: readonly string[];
    readonly requires_human_approval: boolean; readonly requires_vad: boolean; readonly policy_id: string;
    readonly runtime_limits: Readonly<Record<string, unknown>>; readonly cost_limits: Readonly<Record<string, unknown>>; readonly bound_by: string;
  }): { tool: GovernedToolDefinition; binding: ToolPolicyBinding } {
    return this.tx(() => {
      const current = this.getTool(tenantId, toolId);
      if (current.state_version !== expectedVersion) throw new ClientError('CONFLICT', 'Tool state has changed — retry with the current version');
      if (current.review_status === 'REMOVED') throw new ClientError('CONFLICT', 'This tool is no longer advertised by its MCP server and cannot be enabled');
      const now = this.now();
      const verification = decision.requires_vad ? 'vad' : 'none';
      const approvalMode = decision.requires_human_approval ? 'human_approval' : 'none';
      const policyHash = hashValue({ policy_id: decision.policy_id, risk_class: decision.risk_class, approval_mode: approvalMode, runtime_limits: decision.runtime_limits, cost_limits: decision.cost_limits, verification_requirement: verification, schema_hash: current.schema_hash });
      const bindingId = `bind_${randomUUID()}`;
      this.db.prepare('INSERT INTO tool_policy_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        bindingId, tenantId, toolId, decision.policy_id, policyHash, decision.risk_class, approvalMode,
        JSON.stringify(decision.runtime_limits), JSON.stringify(decision.cost_limits), verification, now, decision.bound_by,
      );
      const changed = this.db.prepare("UPDATE governed_tools SET risk_class=?, allowed_operations_json=?, resource_patterns_json=?, enabled=1, requires_human_approval=?, requires_vad=?, review_status='ENABLED', updated_at=?, state_version=state_version+1 WHERE tenant_id=? AND tool_id=? AND state_version=?")
        .run(decision.risk_class, JSON.stringify(decision.allowed_operations), JSON.stringify(decision.resource_patterns), decision.requires_human_approval ? 1 : 0, decision.requires_vad ? 1 : 0, now, tenantId, toolId, expectedVersion);
      if (changed.changes !== 1) throw new ClientError('CONFLICT', 'Tool changed concurrently');
      const binding = this.db.prepare('SELECT * FROM tool_policy_bindings WHERE binding_id=?').get(bindingId) as unknown as { runtime_limits_json: string; cost_limits_json: string } & Omit<ToolPolicyBinding, 'runtime_limits' | 'cost_limits'>;
      return {
        tool: this.getTool(tenantId, toolId),
        binding: { ...binding, runtime_limits: JSON.parse(binding.runtime_limits_json), cost_limits: JSON.parse(binding.cost_limits_json) },
      };
    });
  }
  public disableTool(tenantId: string, toolId: string, expectedVersion: number): GovernedToolDefinition {
    return this.tx(() => {
      const now = this.now();
      const changed = this.db.prepare("UPDATE governed_tools SET enabled=0, review_status='DISABLED', updated_at=?, state_version=state_version+1 WHERE tenant_id=? AND tool_id=? AND state_version=?").run(now, tenantId, toolId, expectedVersion);
      if (changed.changes !== 1) throw new ClientError('CONFLICT', 'Tool changed concurrently');
      return this.getTool(tenantId, toolId);
    });
  }
  public listPolicyBindings(tenantId: string, toolId: string): readonly ToolPolicyBinding[] {
    const rows = this.db.prepare('SELECT * FROM tool_policy_bindings WHERE tenant_id=? AND tool_id=? ORDER BY bound_at').all(tenantId, toolId) as unknown as ({ runtime_limits_json: string; cost_limits_json: string } & Omit<ToolPolicyBinding, 'runtime_limits' | 'cost_limits'>)[];
    return rows.map(row => ({ ...row, runtime_limits: JSON.parse(row.runtime_limits_json), cost_limits: JSON.parse(row.cost_limits_json) }));
  }

  /** Section 23, 67: called once per client action, at submission time, before the action ever reaches
   * the platform — the resulting hash is bound into the client_actions row and never recomputed
   * retroactively, so a later config change cannot rewrite what an already-recorded action saw. */
  public computeIntegrationConfigHash(tenantId: string): string {
    const tenant = this.getTenant(tenantId);
    const services = this.listServiceIdentities(tenantId, { limit: 200 }).items.map(s => ({ service_id: s.service_id, role: s.role, status: s.status }));
    const servers = this.listMcpServers(tenantId).map(s => ({ mcp_server_id: s.mcp_server_id, config_hash: s.config_hash, status: s.status }));
    const tools = this.listTools(tenantId).map(t => ({ tool_id: t.tool_id, enabled: t.enabled, schema_hash: t.schema_hash, risk_class: t.risk_class, review_status: t.review_status }));
    return hashValue({ tenant_id: tenantId, tenant_config_hash: tenant.configuration_hash, services, servers, tools });
  }
  public recordClientAction(record: ClientActionRecord): void {
    this.db.prepare('INSERT INTO client_actions VALUES (?,?,?,?,?,?,?)').run(
      record.tenant_id, record.client_action_id, record.service_id, record.mcp_server_id, record.governed_tool_id,
      record.config_snapshot_hash, record.created_at,
    );
  }
  public getClientAction(tenantId: string, clientActionId: string): ClientActionRecord | null {
    const row = this.db.prepare('SELECT * FROM client_actions WHERE tenant_id=? AND client_action_id=?').get(tenantId, clientActionId) as unknown as ClientActionRecord | undefined;
    return row ?? null;
  }
}

export { toolPlatformId };
export { canonical as canonicalClientValue };

#!/usr/bin/env node
/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). The `tna` operator CLI. Every
 * consequential command is a thin dispatcher over the real HTTP clients in `http-client.ts` — never a
 * direct database access (section 7). Role gating happens locally before any network call (`roles.ts`);
 * server-side authorization (already accepted, untouched) is the real security boundary.
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { loadOperatorProfile, resolveCredential, OperatorConfigError, type OperatorProfile } from './config.js';
import { assertRoleAllows, resolveCommandKey, OperatorAuthError } from './roles.js';
import { PlatformClient, ClientGatewayClient, ImprovementGovernorClient, OperatorHttpError } from './http-client.js';
import { ok, fail, printResult, exitCodeFor, type OperatorCommandResult } from './output.js';
import { runDoctor } from './doctor.js';
import { collectIncidentPackage } from './incident.js';
import { explain } from './explain.js';
import { assessGoLive } from './go-live.js';
import { buildHandoff } from './handoff.js';
import { OperatorAuditLog } from './audit-log.js';
import { AcademyProgressStore } from './academy/progress-store.js';
import { assessLevel, type KnowledgeAnswer } from './academy/assessment.js';
import { LAB_IDS, LAB_META, isLabId, runLabById, labMeta } from '../../../academy/labs/registry.js';
import { questionsForLevel } from '../../../academy/question-bank/loader.js';
import { toLearnerFacing } from '../../../academy/question-bank/schema.js';

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}
function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i += 1; } else { flags[name] = true; }
    } else positionals.push(arg);
  }
  return { positionals, flags };
}

function auditLogPath(): string {
  const dir = process.env.TNA_OPERATOR_AUDIT_DIR ?? resolve(homedir(), '.tna');
  mkdirSync(dir, { recursive: true });
  return process.env.TNA_OPERATOR_AUDIT_PATH ?? resolve(dir, 'operator-audit.sqlite');
}

function academyProgressPath(): string {
  const dir = process.env.TNA_ACADEMY_PROGRESS_DIR ?? resolve(homedir(), '.tna');
  mkdirSync(dir, { recursive: true });
  return process.env.TNA_ACADEMY_PROGRESS_PATH ?? resolve(dir, 'academy-progress.sqlite');
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const jsonMode = flags.json === true;
  const profileName = typeof flags.profile === 'string' ? flags.profile : process.env.TNA_OPERATOR_PROFILE;

  if (positionals.length === 0 || positionals[0] === 'help' || flags.help === true) {
    process.stdout.write('Usage: tna <command> [subcommand] [--profile <name>] [--json] [--reason "..."] [--tenant <id>] ...\n');
    process.exitCode = 0;
    return;
  }

  if (!profileName) {
    printResult(fail('VALIDATION_ERROR', 'No operator profile specified (--profile <name> or TNA_OPERATOR_PROFILE)'), jsonMode);
    process.exitCode = exitCodeFor(fail('VALIDATION_ERROR', ''));
    return;
  }

  let profile: OperatorProfile;
  try { profile = loadOperatorProfile(profileName); }
  catch (error) {
    printResult(fail('VALIDATION_ERROR', error instanceof OperatorConfigError ? error.message : String(error)), jsonMode);
    process.exitCode = exitCodeFor(fail('VALIDATION_ERROR', ''));
    return;
  }

  const commandKey = resolveCommandKey(positionals);
  if (!commandKey) {
    const result = fail('VALIDATION_ERROR', `Unknown command: ${positionals.join(' ')}`);
    printResult(result, jsonMode);
    process.exitCode = exitCodeFor(result);
    return;
  }
  try { assertRoleAllows(commandKey, profile.role); }
  catch (error) {
    const result = fail('FORBIDDEN', error instanceof OperatorAuthError ? error.message : String(error));
    printResult(result, jsonMode);
    process.exitCode = exitCodeFor(result);
    return;
  }

  const platform = profile.platformUrl ? new PlatformClient(profile.platformUrl, resolveCredential(profile.platformTokenEnv)) : undefined;
  const clientGateway = profile.clientGatewayUrl ? new ClientGatewayClient(profile.clientGatewayUrl, resolveCredential(profile.clientGatewayAdminTokenEnv)) : undefined;
  const improvementGovernor = profile.improvementGovernorUrl ? new ImprovementGovernorClient(profile.improvementGovernorUrl, resolveCredential(profile.improvementGovernorTokenEnv)) : undefined;
  const auditLog = new OperatorAuditLog(auditLogPath());
  const academyProgress = new AcademyProgressStore(academyProgressPath());

  const reason = typeof flags.reason === 'string' ? flags.reason : undefined;
  const tenantId = typeof flags.tenant === 'string' ? flags.tenant : undefined;
  // Section 31: a learner_id — defaults to the profile name, but explicitly overridable so one CLI
  // installation can be used by multiple named learners without separate profiles.
  const learnerId = typeof flags.learner === 'string' ? flags.learner : profile.name;

  function recordAudit(operation: string, target: string | null, outcome: 'OK' | 'DENIED' | 'FAILED', before?: unknown, after?: unknown, correlationId?: string): void {
    auditLog.record({
      actor: profile.name, role: profile.role, operation, target, tenant_id: tenantId ?? null,
      reason: reason ?? null, before: before !== undefined ? JSON.stringify(before) : null,
      after: after !== undefined ? JSON.stringify(after) : null, correlation_id: correlationId ?? null, outcome,
    });
  }

  let result: OperatorCommandResult;
  try {
    result = await dispatch(commandKey, positionals, flags, { platform, clientGateway, improvementGovernor, reason, tenantId, profile, recordAudit, academyProgress, learnerId });
  } catch (error) {
    if (error instanceof OperatorHttpError) {
      result = fail(error.status === 403 || error.status === 401 ? 'FORBIDDEN' : error.status === 404 ? 'NOT_FOUND' : 'FAILED', error.message, error.body);
    } else if (error instanceof OperatorConfigError) {
      result = fail('VALIDATION_ERROR', error.message);
    } else {
      result = fail('FAILED', error instanceof Error ? error.message : String(error));
    }
  }
  auditLog.close();
  academyProgress.close();
  printResult(result, jsonMode);
  process.exitCode = exitCodeFor(result);
}

interface DispatchDeps {
  readonly platform?: PlatformClient | undefined; readonly clientGateway?: ClientGatewayClient | undefined;
  readonly improvementGovernor?: ImprovementGovernorClient | undefined;
  readonly reason?: string | undefined; readonly tenantId?: string | undefined; readonly profile: OperatorProfile;
  readonly recordAudit: (operation: string, target: string | null, outcome: 'OK' | 'DENIED' | 'FAILED', before?: unknown, after?: unknown, correlationId?: string) => void;
  readonly academyProgress: AcademyProgressStore; readonly learnerId: string;
}

function requireReason(reason: string | undefined, commandKey: string): string {
  if (!reason || reason.trim().length === 0) throw new OperatorConfigError(`Command "${commandKey}" requires --reason "<why>"`);
  return reason;
}
function requireTenant(tenantId: string | undefined): string {
  if (!tenantId) throw new OperatorConfigError('This command requires --tenant <id>');
  return tenantId;
}
function requirePlatform(platform: PlatformClient | undefined): PlatformClient {
  if (!platform) throw new OperatorConfigError('This profile does not configure platformUrl');
  return platform;
}
function requireClientGateway(clientGateway: ClientGatewayClient | undefined): ClientGatewayClient {
  if (!clientGateway) throw new OperatorConfigError('This profile does not configure clientGatewayUrl');
  return clientGateway;
}
function requireImprovementGovernor(improvementGovernor: ImprovementGovernorClient | undefined): ImprovementGovernorClient {
  if (!improvementGovernor) throw new OperatorConfigError('This profile does not configure improvementGovernorUrl');
  return improvementGovernor;
}
function requireGenerationId(rest: readonly string[]): string {
  const id = rest[0];
  if (!id) throw new OperatorConfigError('This command requires a generation id');
  return id;
}
/** Section M: high-risk improvement operations require --reason AND an exact --confirm <generation-id>
 * match — the same "fat-finger" protection `tenant offboard` already established in Volume 11, carried
 * forward here for promote/rollback/authority-expansion-shaped approvals. */
function requireConfirm(flags: Readonly<Record<string, string | boolean>>, generationId: string, commandKey: string): void {
  if (flags.confirm !== generationId) throw new OperatorConfigError(`Command "${commandKey}" requires --confirm ${generationId} (exact generation id) to prevent a wrong-generation mistake`);
}

async function dispatch(commandKey: string, positionals: readonly string[], flags: Readonly<Record<string, string | boolean>>, deps: DispatchDeps): Promise<OperatorCommandResult> {
  const rest = positionals.slice(commandKey.split(' ').length);

  switch (commandKey) {
    case 'status':
    case 'health': {
      const results: Record<string, unknown> = {};
      if (deps.platform) results.platform = await deps.platform.ready();
      if (deps.clientGateway) results.client_gateway = await deps.clientGateway.ready();
      return ok('Status collected', results);
    }
    case 'doctor': {
      const report = await runDoctor({ platform: deps.platform, clientGateway: deps.clientGateway });
      return report.overall === 'PASS' ? ok(`doctor: ${report.overall}`, report) : fail(report.overall === 'FAIL' ? 'FAILED' : 'INDETERMINATE', `doctor: ${report.overall}`, report);
    }

    case 'tenant list': {
      const result = await requireClientGateway(deps.clientGateway).listTenants();
      return ok('Tenants listed', result);
    }
    case 'tenant show': {
      const id = requireTenant(deps.tenantId ?? rest[0]);
      return ok('Tenant', await requireClientGateway(deps.clientGateway).getTenant(id));
    }
    case 'tenant create': {
      const input = JSON.parse(String(flags.input ?? '{}')) as unknown;
      const created = await requireClientGateway(deps.clientGateway).createTenant(input);
      deps.recordAudit('tenant.create', (created as { tenant_id?: string }).tenant_id ?? null, 'OK', null, created);
      return ok('Tenant created', created);
    }
    case 'tenant activate': {
      const id = requireTenant(deps.tenantId ?? rest[0]);
      const before = await requireClientGateway(deps.clientGateway).getTenant(id) as { state_version: number };
      const after = await requireClientGateway(deps.clientGateway).activateTenant(id, before.state_version);
      deps.recordAudit('tenant.activate', id, 'OK', before, after);
      return ok('Tenant activated', after);
    }
    case 'tenant suspend': {
      const id = requireTenant(deps.tenantId ?? rest[0]);
      const why = requireReason(deps.reason, commandKey);
      const before = await requireClientGateway(deps.clientGateway).getTenant(id) as { state_version: number };
      const after = await requireClientGateway(deps.clientGateway).suspendTenant(id, before.state_version, why);
      deps.recordAudit('tenant.suspend', id, 'OK', before, after);
      return ok('Tenant suspended', after);
    }
    case 'tenant offboard': {
      const id = requireTenant(deps.tenantId ?? rest[0]);
      const why = requireReason(deps.reason, commandKey);
      if (flags.confirm !== id) throw new OperatorConfigError(`Offboarding requires --confirm ${id} (exact tenant id) to prevent a wrong-tenant mistake`);
      const before = await requireClientGateway(deps.clientGateway).getTenant(id) as { state_version: number };
      const after = await requireClientGateway(deps.clientGateway).offboardTenant(id, before.state_version, why);
      deps.recordAudit('tenant.offboard', id, 'OK', before, after);
      return ok('Tenant offboarding started', after);
    }

    case 'service list': return ok('Services', await requireClientGateway(deps.clientGateway).listServices(requireTenant(deps.tenantId)));
    case 'service create': {
      const id = requireTenant(deps.tenantId);
      const input = JSON.parse(String(flags.input ?? '{}')) as unknown;
      const created = await requireClientGateway(deps.clientGateway).createService(id, input);
      deps.recordAudit('service.create', id, 'OK', null, { identity: (created as { identity?: unknown }).identity });
      return ok('Service identity created (credential shown once — save it now, it cannot be retrieved again)', created, [], { sensitive: false });
    }
    case 'service rotate': {
      const id = requireTenant(deps.tenantId);
      const serviceId = rest[0]; if (!serviceId) throw new OperatorConfigError('service rotate requires a service id');
      const sv = Number(flags['state-version']); if (!Number.isInteger(sv)) throw new OperatorConfigError('service rotate requires --state-version <n>');
      const after = await requireClientGateway(deps.clientGateway).rotateService(id, serviceId, sv);
      deps.recordAudit('service.rotate', serviceId, 'OK', null, { rotated: true });
      return ok('Credential rotated (new credential shown once — save it now, it cannot be retrieved again)', after, [], { sensitive: false });
    }
    case 'service revoke': {
      const id = requireTenant(deps.tenantId);
      const serviceId = rest[0]; if (!serviceId) throw new OperatorConfigError('service revoke requires a service id');
      const sv = Number(flags['state-version']); if (!Number.isInteger(sv)) throw new OperatorConfigError('service revoke requires --state-version <n>');
      const after = await requireClientGateway(deps.clientGateway).revokeService(id, serviceId, sv);
      deps.recordAudit('service.revoke', serviceId, 'OK', null, after);
      return ok('Service identity revoked', after);
    }

    case 'mcp list': return ok('MCP servers', await requireClientGateway(deps.clientGateway).listMcpServers(requireTenant(deps.tenantId)));
    case 'mcp register': {
      const id = requireTenant(deps.tenantId);
      const input = JSON.parse(String(flags.input ?? '{}')) as unknown;
      const created = await requireClientGateway(deps.clientGateway).registerMcpServer(id, input);
      deps.recordAudit('mcp.register', (created as { mcp_server_id?: string }).mcp_server_id ?? null, 'OK', null, created);
      return ok('MCP server registered', created);
    }
    case 'mcp discover': {
      const id = requireTenant(deps.tenantId);
      const serverId = rest[0]; if (!serverId) throw new OperatorConfigError('mcp discover requires a server id');
      const result = await requireClientGateway(deps.clientGateway).discoverMcp(id, serverId);
      deps.recordAudit('mcp.discover', serverId, 'OK', null, result);
      return ok('MCP discovery complete', result);
    }
    case 'mcp inspect': {
      const id = requireTenant(deps.tenantId);
      const serverId = rest[0]; if (!serverId) throw new OperatorConfigError('mcp inspect requires a server id');
      const servers = await requireClientGateway(deps.clientGateway).listMcpServers(id) as { mcp_server_id: string }[];
      const found = servers.find(s => s.mcp_server_id === serverId);
      if (!found) return fail('NOT_FOUND', `No such MCP server: ${serverId}`);
      return ok('MCP server', found);
    }

    case 'tool list': return ok('Governed tools', await requireClientGateway(deps.clientGateway).listTools(requireTenant(deps.tenantId)));
    case 'tool inspect': {
      const id = requireTenant(deps.tenantId);
      const toolId = rest[0]; if (!toolId) throw new OperatorConfigError('tool inspect requires a tool id');
      const tools = await requireClientGateway(deps.clientGateway).listTools(id) as { tool_id: string }[];
      const found = tools.find(t => t.tool_id === toolId);
      if (!found) return fail('NOT_FOUND', `No such tool: ${toolId}`);
      return ok('Governed tool', found);
    }
    case 'tool enable': {
      const id = requireTenant(deps.tenantId);
      const toolId = rest[0]; if (!toolId) throw new OperatorConfigError('tool enable requires a tool id');
      const input = JSON.parse(String(flags.input ?? '{}')) as { risk_class?: string; state_version?: number };
      const effectiveKey = input.risk_class === 'CRITICAL' || input.risk_class === 'HIGH' ? 'tool enable-critical' : 'tool enable';
      assertRoleAllows(effectiveKey, deps.profile.role);
      if (effectiveKey === 'tool enable-critical') requireReason(deps.reason, effectiveKey);
      const after = await requireClientGateway(deps.clientGateway).enableTool(id, toolId, input);
      deps.recordAudit('tool.enable', toolId, 'OK', null, after);
      return ok('Tool enabled', after);
    }
    case 'tool disable': {
      const id = requireTenant(deps.tenantId);
      const toolId = rest[0]; if (!toolId) throw new OperatorConfigError('tool disable requires a tool id');
      const sv = Number(flags['state-version']); if (!Number.isInteger(sv)) throw new OperatorConfigError('tool disable requires --state-version <n>');
      const after = await requireClientGateway(deps.clientGateway).disableTool(id, toolId, sv);
      deps.recordAudit('tool.disable', toolId, 'OK', null, after);
      return ok('Tool disabled', after);
    }

    case 'action list': return ok('Actions', await requirePlatform(deps.platform).listActions({}));
    case 'action show': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('action show requires an action id');
      const action = await requirePlatform(deps.platform).getAction(id) as Record<string, unknown>;
      return ok('Action', summarizeAction(action));
    }
    case 'action evidence': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('action evidence requires an action id');
      return ok('Evidence reconstruction', await requirePlatform(deps.platform).getEvidence(id));
    }
    case 'action reconstruct': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('action reconstruct requires an action id');
      return ok('Reconstruction', await requirePlatform(deps.platform).getEvidence(id));
    }
    case 'action explain': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('action explain requires an action id');
      const action = await requirePlatform(deps.platform).getAction(id) as { state: string; error_code: string | null; error_message: string | null; gate_decision: { decision: string; reason: string } | null };
      return ok('Explanation', explain(action));
    }

    case 'hold list': {
      const list = await requirePlatform(deps.platform).listActions({}) as { items: { state: string }[] };
      return ok('Held actions', { items: list.items.filter(i => i.state === 'HELD') });
    }
    case 'hold inspect': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('hold inspect requires an action id');
      return ok('Action', await requirePlatform(deps.platform).getAction(id));
    }
    case 'hold approve': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('hold approve requires an action id');
      const why = requireReason(deps.reason, commandKey);
      const before = await requirePlatform(deps.platform).getAction(id) as { created_by: string; state: string };
      // Section 11: no self-approval — a CLI-side additive guard (Gate's own approver-role separation
      // covers Gate-level approvals; this covers the platform's Sentinel-driven HOLD/resume path, which
      // has no such check of its own).
      if (before.created_by === deps.profile.name) {
        deps.recordAudit('hold.approve', id, 'DENIED', before, null);
        return fail('FORBIDDEN', `Operator "${deps.profile.name}" originated this action and may not approve it themselves`);
      }
      const after = await requirePlatform(deps.platform).approve(id);
      deps.recordAudit('hold.approve', id, 'OK', before, after);
      void why;
      return ok('Action approved/resumed', after);
    }
    case 'hold reject': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('hold reject requires an action id');
      const why = requireReason(deps.reason, commandKey);
      const before = await requirePlatform(deps.platform).getAction(id);
      const after = await requirePlatform(deps.platform).terminate(id, why);
      deps.recordAudit('hold.reject', id, 'OK', before, after);
      return ok('Action rejected/terminated', after);
    }

    case 'incident status': return ok('Incident collection is available', { capable: true });
    case 'incident collect': {
      const pkg = await collectIncidentPackage({ platform: deps.platform, clientGateway: deps.clientGateway, tenantId: deps.tenantId });
      deps.recordAudit('incident.collect', pkg.manifest.package_id, 'OK', null, { manifest_hash: pkg.manifest.manifest_hash });
      return ok(`Incident package ${pkg.manifest.package_id} collected`, pkg);
    }

    case 'audit run': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('audit run requires an action id');
      const result = await requirePlatform(deps.platform).audit(id);
      deps.recordAudit('audit.run', id, 'OK', null, result);
      return ok('Audit run complete', result);
    }
    case 'audit show': {
      const id = rest[0]; if (!id) throw new OperatorConfigError('audit show requires an action id');
      return ok('Action (includes prior audit evidence via reconstruction)', await requirePlatform(deps.platform).getEvidence(id));
    }

    case 'go-live assess': {
      const assessment = await gatherAndAssessGoLive(deps, flags);
      deps.recordAudit('go-live.assess', assessment.tenant_id, 'OK', null, { status: assessment.status, snapshot_hash: assessment.snapshot_hash });
      return assessment.status === 'GO' || assessment.status === 'GO_WITH_LIMITATIONS' ? ok(`Go-live: ${assessment.status}`, assessment) : fail(assessment.status === 'NO_GO' ? 'FAILED' : 'INDETERMINATE', `Go-live: ${assessment.status}`, assessment);
    }
    case 'handoff generate': {
      const assessment = await gatherAndAssessGoLive(deps, flags);
      const id = requireTenant(deps.tenantId);
      const tools = await requireClientGateway(deps.clientGateway).listTools(id) as { tool_id: string; external_tool_name: string; enabled: boolean; risk_class: string | null }[];
      const diagnostics = deps.platform ? await deps.platform.diagnostics() as { deployment_id: string; component_versions: Record<string, string> } : { deployment_id: 'unknown', component_versions: {} };
      const handoff = buildHandoff({
        deployment_id: diagnostics.deployment_id, component_versions: diagnostics.component_versions, tenant_id: id,
        enabled_tools: tools.filter(t => t.enabled).map(t => ({ tool_id: t.tool_id, external_tool_name: t.external_tool_name, risk_class: t.risk_class })),
        policy_bindings_count: tools.filter(t => t.enabled).length,
        known_limitations: ['MCP server code is not inherently trusted', 'TNA cannot guarantee complete mediation against a parallel client credential', 'No binary attestation for MCP servers'],
        bypass_assessment: assessment.bypass_assessment, backup_status: 'not assessed by this handoff (see go-live checks)',
        health_status: assessment.status, go_live_assessment: assessment,
      });
      deps.recordAudit('handoff.generate', id, 'OK', null, { handoff_hash: handoff.handoff_hash });
      return ok('Client deployment handoff generated', handoff);
    }

    case 'deployment status': {
      const results: Record<string, unknown> = {};
      if (deps.platform) results.platform = await deps.platform.diagnostics();
      return ok('Deployment status', results);
    }

    case 'academy status': {
      const entries = deps.academyProgress.listForLearner(deps.learnerId);
      return ok(`Academy progress for ${deps.learnerId}`, { learner_id: deps.learnerId, labs: LAB_META, entries });
    }
    case 'academy lesson': {
      const lessonId = rest[0]; if (!lessonId) throw new OperatorConfigError('academy lesson requires a lesson id');
      const level = Number(flags.level); if (![1, 2, 3, 4].includes(level)) throw new OperatorConfigError('academy lesson requires --level 1|2|3|4');
      const entry = deps.academyProgress.recordLessonViewed(deps.learnerId, level as 1 | 2 | 3 | 4, lessonId);
      return ok(`Lesson ${lessonId} marked in progress — see academy/curriculum-v0.1.md for content`, entry);
    }
    case 'academy lab start': {
      const labId = rest[0]; if (!labId || !isLabId(labId)) throw new OperatorConfigError(`academy lab start requires a known lab id (${LAB_IDS.join(', ')})`);
      const meta = labMeta(labId);
      return ok(`Lab ${labId}: ${meta.title} (Level ${meta.level}${meta.destructive ? ', destructive — requires ACADEMY_LAB_MODE=true' : ''}) — run "academy lab verify ${labId}" to attempt it`, meta);
    }
    case 'academy lab verify': {
      const labId = rest[0]; if (!labId || !isLabId(labId)) throw new OperatorConfigError(`academy lab verify requires a known lab id (${LAB_IDS.join(', ')})`);
      const meta = labMeta(labId);
      // Section 9: the ONLY inputs here are the lab id and the real verifier's own output — nothing
      // learner-supplied about pass/fail, score, or evidence is ever accepted.
      const result = await runLabById(labId);
      const entry = deps.academyProgress.recordLabAttempt(deps.learnerId, meta.level, result);
      return result.passed
        ? ok(`Lab ${labId} PASSED (real, verified)`, { result, progress: entry })
        : fail('FAILED', `Lab ${labId} FAILED`, { result, progress: entry });
    }
    case 'academy assessment': {
      const level = Number(rest[0]); if (![1, 2, 3, 4].includes(level)) throw new OperatorConfigError('academy assessment requires a level: 1|2|3|4');
      if (flags.questions === true) {
        // Section 3: correct_answer is never exposed before submission.
        return ok(`Level ${level} knowledge questions`, questionsForLevel(level as 1 | 2 | 3 | 4).map(toLearnerFacing));
      }
      const rawAnswers = typeof flags.answers === 'string' ? JSON.parse(flags.answers) as unknown : [];
      if (!Array.isArray(rawAnswers) || !rawAnswers.every(a => typeof a === 'object' && a !== null && typeof (a as Record<string, unknown>).question_id === 'string' && typeof (a as Record<string, unknown>).answer === 'string')) {
        throw new OperatorConfigError('--answers must be a JSON array of {question_id, answer}');
      }
      const assessment = assessLevel({ progress: deps.academyProgress, learnerId: deps.learnerId, level: level as 1 | 2 | 3 | 4, answers: rawAnswers as readonly KnowledgeAnswer[] });
      return assessment.status === 'PASSED'
        ? ok(`Level ${level} Completion Assessment: PASSED`, assessment)
        : fail('FAILED', `Level ${level} Completion Assessment: FAILED`, assessment);
    }

    // TNA Recursive Improvement Governance v0.1 (Volume 12), section L-M: every improvement command
    // below is a thin dispatcher over the real governor HTTP API — never direct ImprovementStore access.
    case 'improvement list': {
      const systemId = typeof flags.system === 'string' ? flags.system : undefined;
      if (!systemId) throw new OperatorConfigError('improvement list requires --system <systemId>');
      return ok('Improvement generations', await requireImprovementGovernor(deps.improvementGovernor).list(systemId));
    }
    case 'improvement show':
      return ok('Improvement generation', await requireImprovementGovernor(deps.improvementGovernor).show(requireGenerationId(rest)));
    case 'improvement evidence':
      return ok('Improvement evidence', await requireImprovementGovernor(deps.improvementGovernor).evidence(requireGenerationId(rest)));
    case 'improvement lineage':
      return ok('Improvement lineage', await requireImprovementGovernor(deps.improvementGovernor).lineage(requireGenerationId(rest)));
    case 'improvement propose': {
      const input = JSON.parse(String(flags.input ?? '{}')) as unknown;
      return ok('Improvement generation proposed', await requireImprovementGovernor(deps.improvementGovernor).propose(input));
    }
    case 'improvement authorize':
      return ok('Improvement generation authorization', await requireImprovementGovernor(deps.improvementGovernor).authorize(requireGenerationId(rest)));
    case 'improvement build': {
      const input = JSON.parse(String(flags.input ?? '{}')) as unknown;
      return ok('Improvement generation build', await requireImprovementGovernor(deps.improvementGovernor).build(requireGenerationId(rest), input));
    }
    case 'improvement evaluate': {
      const input = JSON.parse(String(flags.input ?? '{}')) as unknown;
      const result = await requireImprovementGovernor(deps.improvementGovernor).evaluate(requireGenerationId(rest), input);
      const evaluation = (result as { evaluation?: { status?: string } }).evaluation;
      return evaluation?.status === 'PROMOTE'
        ? ok('Improvement generation evaluated: eligible to proceed', result)
        : fail('FAILED', `Improvement generation evaluated: ${evaluation?.status ?? 'UNKNOWN'}`, result);
    }
    case 'improvement diff':
    case 'improvement capability-delta': {
      // Both are read-only views over the same real, already-recorded evidence — never a separate
      // computation of their own.
      return ok('Improvement evidence', await requireImprovementGovernor(deps.improvementGovernor).evidence(requireGenerationId(rest)));
    }
    case 'improvement approve': {
      const generationId = requireGenerationId(rest);
      requireReason(deps.reason, commandKey);
      const operation = typeof flags.operation === 'string' ? flags.operation : undefined;
      if (!operation) throw new OperatorConfigError('improvement approve requires --operation <name>');
      const approverRole = typeof flags['approver-role'] === 'string' ? flags['approver-role'] : undefined;
      return ok('Improvement operation approved', await requireImprovementGovernor(deps.improvementGovernor).approve(generationId, { operation, approverRole, reason: deps.reason }));
    }
    case 'improvement canary': {
      const generationId = requireGenerationId(rest);
      const approvalId = typeof flags.approval === 'string' ? flags.approval : undefined;
      return ok('Improvement canary', await requireImprovementGovernor(deps.improvementGovernor).canary(generationId, { approvalId }));
    }
    case 'improvement promote': {
      const generationId = requireGenerationId(rest);
      requireReason(deps.reason, commandKey);
      requireConfirm(flags, generationId, commandKey);
      const approvalId = typeof flags.approval === 'string' ? flags.approval : undefined;
      if (!approvalId) throw new OperatorConfigError('improvement promote requires --approval <approvalId> from a prior "improvement approve"');
      return ok('Improvement generation promoted', await requireImprovementGovernor(deps.improvementGovernor).promote(generationId, { approvalId }));
    }
    case 'improvement rollback': {
      const generationId = requireGenerationId(rest);
      requireReason(deps.reason, commandKey);
      requireConfirm(flags, generationId, commandKey);
      const approvalId = typeof flags.approval === 'string' ? flags.approval : undefined;
      const targetGenerationId = typeof flags.target === 'string' ? flags.target : undefined;
      if (!approvalId) throw new OperatorConfigError('improvement rollback requires --approval <approvalId> from a prior "improvement approve"');
      if (!targetGenerationId) throw new OperatorConfigError('improvement rollback requires --target <generationId>');
      return ok('Improvement generation rolled back', await requireImprovementGovernor(deps.improvementGovernor).rollback(generationId, { approvalId, targetGenerationId, trigger: 'MANUAL' }));
    }
    case 'improvement explain': {
      const evidence = await requireImprovementGovernor(deps.improvementGovernor).evidence(requireGenerationId(rest)) as { reconstruction: { finalState: string; evaluated: Record<string, unknown> | null }; assessment: { overall: string; controls: { control_id: string; status: string; reason: string }[] } };
      // Section 101: deterministic, rules-based explanation — no LLM decides what happened here, the
      // same original machine evidence (`reconstruction`/`assessment`) is always shown alongside it.
      const failingControls = evidence.assessment.controls.filter(c => c.status !== 'PASS');
      const summary = failingControls.length === 0
        ? `Generation reached final state ${evidence.reconstruction.finalState}; every assessed control passed.`
        : `Generation reached final state ${evidence.reconstruction.finalState}; ${failingControls.length} control(s) did not cleanly pass: ${failingControls.map(c => `${c.control_id}=${c.status} (${c.reason})`).join('; ')}.`;
      return ok(summary, evidence);
    }

    default:
      return fail('VALIDATION_ERROR', `Unknown command: ${commandKey}`);
  }
}

interface PlatformReadinessComponents { ready: boolean; components: readonly { component: string; status: string }[] }
interface ClientHealth { tenant_status: string; active_services: number; reachable_servers: number; enabled_tools: number; tools_requiring_review: number }

async function gatherAndAssessGoLive(deps: DispatchDeps, flags: Readonly<Record<string, string | boolean>>) {
  const id = requireTenant(deps.tenantId);
  const platformReady = deps.platform ? await deps.platform.ready() as PlatformReadinessComponents : { ready: false, components: [] };
  const componentAvailable = (name: string): boolean => platformReady.components.find(c => c.component === name)?.status === 'AVAILABLE';
  const health = await requireClientGateway(deps.clientGateway).health(id) as ClientHealth;

  const testActionId = typeof flags['test-action'] === 'string' ? flags['test-action'] : undefined;
  let testActionCompleted: boolean | null = null;
  if (testActionId && deps.platform) {
    const action = await deps.platform.getAction(testActionId) as { state: string };
    testActionCompleted = action.state === 'COMPLETED';
  }

  const hasBypassFlags = flags['bypass-tna-chain'] !== undefined || flags['bypass-external-credential'] !== undefined;
  return assessGoLive({
    tenant_id: id,
    deployment_ready: platformReady.ready || !deps.platform,
    gate_available: deps.platform ? componentAvailable('gate') : true,
    sentinel_available: deps.platform ? componentAvailable('sentinel') : true,
    ledger_available: deps.platform ? componentAvailable('ledger') : true,
    tenant_active: health.tenant_status === 'ACTIVE',
    active_services: health.active_services,
    reachable_mcp_servers: health.reachable_servers,
    enabled_tools: health.enabled_tools,
    tools_requiring_review: health.tools_requiring_review,
    bypass_attestation: hasBypassFlags ? { tnaCredentialChain: flags['bypass-tna-chain'] === true || flags['bypass-tna-chain'] === 'true', externalDirectCredential: flags['bypass-external-credential'] === true || flags['bypass-external-credential'] === 'true' } : null,
    test_action_completed: testActionCompleted,
    backup_age_seconds: null, max_backup_age_seconds: 86_400,
    allow_known_bypass_with_limitations: flags['allow-known-bypass'] === true,
  });
}

function summarizeAction(action: Record<string, unknown>): unknown {
  const request = action.request as Record<string, unknown> | undefined;
  return {
    action_id: action.platform_action_id, tenant: action.tenant_id,
    tool: request?.tool, risk: (request?.metadata as Record<string, unknown> | undefined)?.governed_tool_id ?? null,
    gate_decision: (action.gate_decision as { decision?: string } | null)?.decision ?? null,
    capability: action.capability_id ? 'ISSUED' : 'NONE', sentinel_status: action.sentinel_session_id ? 'SESSION_CREATED' : 'NONE',
    execution_outcome: action.state, vad_outcome: action.vad_final_state ?? null,
    evidence_state: action.result_hash ? 'PRESENT' : 'NONE', audit_state: 'RUN_ON_DEMAND',
    correlation_id: action.correlation_id,
  };
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 5; });

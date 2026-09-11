import { createHash, randomUUID } from 'node:crypto';

/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). MCP server registration, governed tool
 * identity, risk classification, and the MCP-specific error vocabulary. This package defines shape and
 * pure rules only — no process spawning, no network I/O (that lives in `packages/mcp-gateway`), and no
 * trust decision beyond what a fixed, deterministic rule table can express (section 21: "Do not use LLM
 * judgment in v0.1").
 */

export const MAX_MCP_SERVERS_PER_TENANT = 10;
export const MAX_TOOLS_PER_SERVER = 200;
export const MAX_TOOL_SCHEMA_BYTES = 32_768;
export const MAX_MCP_RESULT_BYTES = 131_072;
export const MAX_DISCOVERY_RUNTIME_MS = 10_000;
export const MAX_MCP_CALL_RUNTIME_MS = 30_000;
export const MAX_MCP_STARTUP_MS = 5_000;
export const MAX_MCP_SHUTDOWN_MS = 3_000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}
export function hashSchema(schema: unknown): string { return createHash('sha256').update(canonical(schema)).digest('hex'); }
export function hashConfig(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

// ---------------------------------------------------------------------------------------------
// MCP error vocabulary (section 25) — every protocol/runtime failure maps to one of these, never a
// generic 500 / unlabeled Error.
// ---------------------------------------------------------------------------------------------

export const MCP_ERROR_CODES = [
  'MCP_SERVER_UNAVAILABLE', 'MCP_INITIALIZATION_FAILED', 'MCP_TOOL_NOT_FOUND', 'MCP_SCHEMA_DRIFT',
  'MCP_TOOL_DISABLED', 'MCP_TIMEOUT', 'MCP_PROTOCOL_ERROR', 'MCP_RESULT_TOO_LARGE', 'MCP_INDETERMINATE',
] as const;
export type McpErrorCode = typeof MCP_ERROR_CODES[number];
export class McpError extends Error {
  public constructor(public readonly code: McpErrorCode, message: string) {
    super(message);
    this.name = 'McpError';
  }
}

// ---------------------------------------------------------------------------------------------
// MCP server registration (section 13-14, 20, 28-30)
// ---------------------------------------------------------------------------------------------

export const MCP_TRANSPORTS = ['stdio'] as const;
export type McpTransport = typeof MCP_TRANSPORTS[number];
export const MCP_SERVER_STATUSES = ['REGISTERED', 'REACHABLE', 'UNREACHABLE', 'DISABLED'] as const;
export type McpServerStatus = typeof MCP_SERVER_STATUSES[number];

export interface McpServerRegistration {
  readonly mcp_server_id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly transport: McpTransport;
  /** Section 14: a bare executable path — never a shell string. */
  readonly executable: string;
  /** Section 14: an argument vector — never string-concatenated or shell-interpolated. */
  readonly args: readonly string[];
  /** Section 28: an explicit allowlist of environment variable *names* the child process may inherit
   * from the gateway process's own environment; nothing else is passed through (section 29). */
  readonly env_allowlist: readonly string[];
  readonly credential_ref: string | null;
  readonly status: McpServerStatus;
  readonly created_at: string;
  readonly config_hash: string;
  readonly state_version: number;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;
/** A bare filesystem path — letters, digits, spaces, and the usual path punctuation, including the
 * spaces and parentheses real-world install paths use (Windows's `C:\Program Files\nodejs\node.exe` or
 * `C:\Program Files (x86)\...`) — never shell metacharacters, checked separately below. */
const EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/\\:() -]{0,499}$/;
const SHELL_INJECTION_PATTERN = /[;&|`\n\r]|\$\(/;
const PATH_STRUCTURE_PATTERN = /[/\\]|^[A-Za-z]:/;
const ARG_MAX_LENGTH = 2000;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** A space is only legitimate inside `executable` when it sits within actual path structure (a `/`, a
 * `\`, or a drive letter) — a real install path, not a smashed-together "word word" command. `bash -c
 * evil` and `a b` have no path structure at all and are rejected; `C:\Program Files\nodejs\node.exe`
 * does and is allowed. This is the narrow, precise distinction `shell:false` alone doesn't make for an
 * operator: it can't stop someone from misconfiguring `args` into `executable`, it only stops the shell
 * from ever interpreting the result. */
function looksLikeBareCommandInjection(executable: string): boolean {
  return /\s/.test(executable) && !PATH_STRUCTURE_PATTERN.test(executable);
}

export interface McpServerRegisterInput {
  readonly name: string;
  readonly transport: McpTransport;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env_allowlist: readonly string[];
  readonly credential_ref: string | null;
}
/** Section 13-14: strict, structural validation — a bare executable + argv, never a single command
 * string a shell would interpret. Rejects anything shaped like an attempt to smuggle shell metacharacters
 * through an argument (`;`, `|`, `&&`, backticks, `$(`), even though `shell:false` in `mcp-gateway`
 * already makes such characters inert — defense in depth, and an honest signal to the operator that the
 * input looked like a shell-injection attempt. */
export function validateMcpServerRegisterInput(raw: unknown): McpServerRegisterInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new McpError('MCP_PROTOCOL_ERROR', 'MCP server registration input must be an object');
  const obj = raw as Record<string, unknown>;
  const allowed = ['name', 'transport', 'executable', 'args', 'env_allowlist', 'credential_ref'];
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new McpError('MCP_PROTOCOL_ERROR', `Unknown field: ${key}`);
  if (typeof obj.name !== 'string' || !NAME_PATTERN.test(obj.name)) throw new McpError('MCP_PROTOCOL_ERROR', 'name must be a safe, bounded string');
  if (obj.transport !== 'stdio') throw new McpError('MCP_PROTOCOL_ERROR', 'transport must be "stdio" in v0.1');
  if (typeof obj.executable !== 'string' || !EXECUTABLE_PATTERN.test(obj.executable)) throw new McpError('MCP_PROTOCOL_ERROR', 'executable must be a bare path, not a shell command string');
  if (SHELL_INJECTION_PATTERN.test(obj.executable)) throw new McpError('MCP_PROTOCOL_ERROR', `executable looks like an attempted shell-injection payload: ${obj.executable.slice(0, 40)}`);
  if (looksLikeBareCommandInjection(obj.executable)) throw new McpError('MCP_PROTOCOL_ERROR', `executable "${obj.executable}" looks like a smashed-together command, not a bare path — put arguments in args[] instead`);
  if (!Array.isArray(obj.args) || obj.args.some(a => typeof a !== 'string' || a.length > ARG_MAX_LENGTH)) throw new McpError('MCP_PROTOCOL_ERROR', 'args must be an array of bounded strings');
  for (const arg of obj.args as string[]) {
    if (SHELL_INJECTION_PATTERN.test(arg)) throw new McpError('MCP_PROTOCOL_ERROR', `arg looks like an attempted shell-injection payload: ${arg.slice(0, 40)}`);
  }
  if (!Array.isArray(obj.env_allowlist) || obj.env_allowlist.some(e => typeof e !== 'string' || !ENV_NAME_PATTERN.test(e))) {
    throw new McpError('MCP_PROTOCOL_ERROR', 'env_allowlist must be an array of uppercase environment variable names');
  }
  if (obj.credential_ref !== null && typeof obj.credential_ref !== 'string') throw new McpError('MCP_PROTOCOL_ERROR', 'credential_ref must be a string or null');
  return {
    name: obj.name, transport: 'stdio', executable: obj.executable, args: [...(obj.args as string[])],
    env_allowlist: [...(obj.env_allowlist as string[])], credential_ref: (obj.credential_ref as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Governed tool (section 17-20, 32)
// ---------------------------------------------------------------------------------------------

export const TOOL_REVIEW_STATUSES = ['DISCOVERED', 'ENABLED', 'DISABLED', 'POLICY_REVIEW_REQUIRED', 'REMOVED'] as const;
export type ToolReviewStatus = typeof TOOL_REVIEW_STATUSES[number];

export interface GovernedToolDefinition {
  readonly tenant_id: string;
  readonly tool_id: string;
  readonly provider_type: 'mcp';
  readonly provider_id: string;
  readonly external_tool_name: string;
  readonly description: string;
  readonly input_schema: unknown;
  readonly schema_hash: string;
  readonly risk_class: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  readonly allowed_operations: readonly string[];
  readonly resource_patterns: readonly string[];
  readonly enabled: boolean;
  readonly requires_human_approval: boolean;
  readonly requires_vad: boolean;
  readonly review_status: ToolReviewStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly state_version: number;
}
export function newToolId(): string { return `gt_${randomUUID()}`; }
/** Section 108-109: a governed tool's platform-facing identity is always this UUID-based id — never the
 * external tool name — so two MCP servers exposing a tool of the same name can never collide, and a
 * malicious server cannot impersonate another server's tool merely by reusing its name. */
export function toolPlatformId(toolId: string): string { return `mcp.${toolId}`; }

// ---------------------------------------------------------------------------------------------
// Risk classification (section 21, 105-107). Deterministic, table-driven — never inferred from the
// MCP server's own tool description/annotations, and never assigned by the client itself.
// ---------------------------------------------------------------------------------------------

export const RISK_CATEGORIES = ['general', 'financial', 'credential-mutation', 'code-execution', 'filesystem-write', 'deployment'] as const;
export type RiskCategory = typeof RISK_CATEGORIES[number];
export interface RiskClassificationInput {
  readonly operation: 'read' | 'write' | 'execute';
  readonly network_required: boolean;
  readonly category: RiskCategory;
}
/** A fixed rule table (section 21) — an operator supplies the honest, reviewed facts about a tool
 * (operation shape, network requirement, category); this function is the one place those facts become
 * a risk class, so classification is reproducible and auditable rather than an ad hoc operator guess. */
export function classifyRisk(input: RiskClassificationInput): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (input.category === 'deployment' || input.category === 'code-execution' || input.category === 'credential-mutation') return 'CRITICAL';
  if (input.category === 'financial' || input.category === 'filesystem-write') return 'HIGH';
  if (input.operation === 'write' && input.network_required) return 'HIGH';
  if (input.operation === 'write' || input.operation === 'execute') return 'MEDIUM';
  if (input.operation === 'read' && input.network_required) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------------------------
// Normalized MCP tool (discovery output, section 15, 148-149)
// ---------------------------------------------------------------------------------------------

export interface DiscoveredMcpTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
}
/** Section 148: reject a malformed/garbage schema outright rather than registering it. Section 149: an
 * unsupported JSON Schema shape (not a plain object, or absent) is flagged rather than silently trusted. */
export function validateDiscoveredTool(raw: unknown): DiscoveredMcpTool {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new McpError('MCP_PROTOCOL_ERROR', 'Discovered tool entry must be an object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0 || obj.name.length > 200) throw new McpError('MCP_PROTOCOL_ERROR', 'Discovered tool name must be a non-empty bounded string');
  const description = typeof obj.description === 'string' ? obj.description.slice(0, 2000) : '';
  const schema = obj.inputSchema ?? obj.input_schema ?? {};
  if (typeof schema !== 'object' || schema === null) throw new McpError('MCP_PROTOCOL_ERROR', `Tool ${obj.name} has an unsupported (non-object) input schema — SCHEMA_UNSUPPORTED`);
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (bytes > MAX_TOOL_SCHEMA_BYTES) throw new McpError('MCP_PROTOCOL_ERROR', `Tool ${obj.name} schema exceeds ${MAX_TOOL_SCHEMA_BYTES} bytes`);
  return { name: obj.name, description, input_schema: schema };
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  McpError, MAX_MCP_RESULT_BYTES, MAX_MCP_STARTUP_MS, MAX_DISCOVERY_RUNTIME_MS, MAX_MCP_CALL_RUNTIME_MS,
  MAX_MCP_SHUTDOWN_MS, validateDiscoveredTool, type DiscoveredMcpTool,
} from '../../mcp-schema/src/index.js';

/**
 * TNA Client Integration & MCP Gateway v0.1 (Volume 10). A real, minimal MCP stdio client: spawns a
 * child process with an explicit executable/argv (never a shell string — section 14), speaks
 * newline-delimited JSON-RPC 2.0 (the actual MCP stdio wire format — `initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call`), and bounds every phase with an explicit
 * timeout (section 26). This is deliberately the narrow subset of MCP this milestone needs — not a
 * general-purpose protocol SDK (section 12: "do not build a huge protocol abstraction prematurely").
 *
 * `AGENT / CLIENT -> TNA PLATFORM -> GATE -> CAPABILITY -> SENTINEL -> TNA MCP GATEWAY -> MCP SERVER ->
 * TOOL` (section 11): nothing in this file is reachable except through a connector `platform-core`'s
 * `ExecutionBroker` invokes after Gate/Sentinel have already cleared the call — this class has no HTTP
 * surface of its own and is never imported by anything client-facing directly.
 */

export interface McpStdioClientOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly envAllowlist: readonly string[];
  /** Section 29: the *only* way a credential reaches the child process — never a blanket-inherited
   * gateway environment variable. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly timeouts?: {
    readonly startupMs?: number; readonly discoveryMs?: number; readonly callMs?: number; readonly shutdownMs?: number;
  };
}

export interface McpToolCallResult {
  readonly content: unknown;
  readonly is_error: boolean;
  readonly bytes: number;
}

interface PendingRequest { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }

function buildChildEnv(envAllowlist: readonly string[], extraEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of envAllowlist) { const value = process.env[name]; if (value !== undefined) env[name] = value; }
  if (env.PATH === undefined && process.env.PATH !== undefined) env.PATH = process.env.PATH;
  for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
  return env;
}
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Internal transport-level failure — never thrown to a caller of the public methods below, always
 * remapped to the correct `McpError` code for the phase that was in flight (section 25). */
class TransportFailure extends Error {
  public constructor(public readonly reason: 'timeout' | 'exit' | 'protocol' | 'spawn', message: string) { super(message); }
}

export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderrTail = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private exited = false;
  private exitError: TransportFailure | null = null;
  private readonly timeouts: Required<NonNullable<McpStdioClientOptions['timeouts']>>;

  public constructor(private readonly options: McpStdioClientOptions) {
    this.timeouts = {
      startupMs: options.timeouts?.startupMs ?? MAX_MCP_STARTUP_MS,
      discoveryMs: options.timeouts?.discoveryMs ?? MAX_DISCOVERY_RUNTIME_MS,
      callMs: options.timeouts?.callMs ?? MAX_MCP_CALL_RUNTIME_MS,
      shutdownMs: options.timeouts?.shutdownMs ?? MAX_MCP_SHUTDOWN_MS,
    };
  }

  public get pid(): number | null { return this.proc?.pid ?? null; }

  /** Section 27: start -> initialize -> ready. Spawns the child (shell:false, explicit argv, explicit
   * bounded environment) and performs the real MCP handshake. */
  public async connect(): Promise<void> {
    if (this.proc) throw new McpError('MCP_PROTOCOL_ERROR', 'This client is already connected');
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.options.executable, [...this.options.args], {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv(this.options.envAllowlist, this.options.extraEnv ?? {}),
      });
    } catch (error) {
      throw new McpError('MCP_SERVER_UNAVAILABLE', `Failed to spawn MCP server: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => this.onStdoutChunk(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    proc.on('error', error => this.onProcessGone(new TransportFailure('spawn', error.message)));
    proc.on('exit', code => this.onProcessGone(new TransportFailure('exit', `MCP server process exited (code ${code ?? 'null'})${this.stderrTail ? `: ${this.stderrTail.slice(-300)}` : ''}`)));

    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tna-mcp-gateway', version: '0.1.0' },
      }, this.timeouts.startupMs);
    } catch (error) {
      throw this.remap(error, 'MCP_INITIALIZATION_FAILED');
    }
    this.notify('notifications/initialized', {});
  }

  public async listTools(): Promise<readonly DiscoveredMcpTool[]> {
    let result: unknown;
    try { result = await this.request('tools/list', {}, this.timeouts.discoveryMs); }
    catch (error) { throw this.remap(error, 'MCP_SERVER_UNAVAILABLE'); }
    if (typeof result !== 'object' || result === null || !Array.isArray((result as { tools?: unknown }).tools)) {
      throw new McpError('MCP_PROTOCOL_ERROR', 'tools/list response did not contain a tools array');
    }
    return (result as { tools: unknown[] }).tools.map(validateDiscoveredTool);
  }

  /** Section 63: if the server dies mid-call, the outcome is genuinely unknown — `MCP_INDETERMINATE`,
   * never a fabricated success and never blindly retried by this layer (TNA-48). */
  public async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolCallResult> {
    let result: unknown;
    try { result = await this.request('tools/call', { name, arguments: args }, this.timeouts.callMs); }
    catch (error) {
      const failure = error instanceof TransportFailure ? error : null;
      if (failure?.reason === 'exit') throw new McpError('MCP_INDETERMINATE', `MCP server exited during tool call — outcome unknown: ${failure.message}`);
      throw this.remap(error, 'MCP_TIMEOUT');
    }
    if (typeof result !== 'object' || result === null) throw new McpError('MCP_PROTOCOL_ERROR', 'tools/call response was not an object');
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (bytes > MAX_MCP_RESULT_BYTES) throw new McpError('MCP_RESULT_TOO_LARGE', `MCP tool result is ${bytes} bytes, exceeding the ${MAX_MCP_RESULT_BYTES}-byte bound`);
    const content = (result as { content?: unknown }).content ?? null;
    const isError = (result as { isError?: unknown }).isError === true;
    return { content, is_error: isError, bytes };
  }

  /** Section 27, 97: bounded graceful shutdown, escalating to a forced kill — never an indefinite wait,
   * and never a leaked child process. */
  public async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.exited) { this.cleanupPending(); return; }
    const pid = proc.pid;
    proc.kill('SIGTERM');
    const deadline = Date.now() + this.timeouts.shutdownMs;
    while (!this.exited && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    if (!this.exited && pid !== undefined) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    this.cleanupPending();
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }
  private write(message: Record<string, unknown>): void {
    if (!this.proc) throw new McpError('MCP_SERVER_UNAVAILABLE', 'MCP client is not connected');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exitError ?? new TransportFailure('exit', 'MCP server is not running'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new TransportFailure('timeout', `MCP request "${method}" timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private onStdoutChunk(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) continue;
      this.onLine(line);
    }
  }
  private onLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { this.failAllPending(new TransportFailure('protocol', `MCP server sent a non-JSON line: ${line.slice(0, 200)}`)); return; }
    if (typeof message !== 'object' || message === null || !('id' in message)) return; // a notification from the server — nothing pending to resolve
    const { id, result, error } = message as { id: unknown; result?: unknown; error?: { message?: string } };
    if (typeof id !== 'number' || !this.pending.has(id)) return;
    const entry = this.pending.get(id)!;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(new TransportFailure('protocol', `MCP server returned an error: ${error.message ?? 'unknown error'}`));
    else entry.resolve(result);
  }
  private onProcessGone(failure: TransportFailure): void {
    if (this.exited) return;
    this.exited = true;
    this.exitError = failure;
    this.failAllPending(failure);
  }
  private failAllPending(failure: TransportFailure): void {
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(failure); this.pending.delete(id); }
  }
  private cleanupPending(): void { this.failAllPending(new TransportFailure('exit', 'MCP client shut down')); }
  private remap(error: unknown, fallback: import('../../mcp-schema/src/index.js').McpErrorCode): McpError {
    if (error instanceof McpError) return error;
    if (error instanceof TransportFailure) {
      if (error.reason === 'timeout') return new McpError('MCP_TIMEOUT', error.message);
      if (error.reason === 'protocol') return new McpError('MCP_PROTOCOL_ERROR', error.message);
      if (error.reason === 'exit' || error.reason === 'spawn') return new McpError('MCP_SERVER_UNAVAILABLE', error.message);
    }
    return new McpError(fallback, error instanceof Error ? error.message : String(error));
  }
}

export { isPidAlive };

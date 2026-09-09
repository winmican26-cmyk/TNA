import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';

export type NetworkMode = 'unrestricted' | 'preflight-only';
export type IsolatedExecutionRequest = {
  execution_id: string; agent_id: string; tool: string; operation: string; command: string; args: readonly string[];
  workspace: string; cwd: string; env: Readonly<Record<string, string>>; runtime_limit_ms: number;
  stdout_limit_bytes: number; stderr_limit_bytes: number; output_limit_bytes: number;
  no_network: { requested: boolean; mode: NetworkMode };
};
export type OutputDigest = { bytes: number; sha256: string; preview: string };
export type IsolationState = 'SUCCEEDED' | 'FAILED' | 'TERMINATED';
export type IsolationReason = 'completed' | 'non_zero_exit' | 'child_error' | 'runtime_limit' | 'output_limit';
export type IsolatedExecutionResult = {
  execution_id: string; state: IsolationState; reason: IsolationReason; exit_code: number | null; signal: NodeJS.Signals | null;
  stdout: OutputDigest; stderr: OutputDigest;
  network: { requested: boolean; mode: NetworkMode; enforcement: 'not-enforced' };
};

export class IsolationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'IsolationError'; }
}
export interface IsolationRunner { run(request: IsolatedExecutionRequest): Promise<IsolatedExecutionResult>; }
export type ChildProcessIsolationRunnerOptions = { strictNetwork?: boolean };

const forbiddenEnvironmentKey = /(?:capability|admin|approver|database|secret|token|password|credential|private[_-]?key)/i;
const controlCharacter = (value: string): boolean => Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
function requireText(value: string, field: string): void { if (typeof value !== 'string' || value.length === 0 || controlCharacter(value)) throw new IsolationError('INVALID_REQUEST', `${field} must be non-empty text without control characters`); }
function requireLimit(value: number, field: string, allowZero = false): void { if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) throw new IsolationError('INVALID_REQUEST', `${field} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`); }
function validateCwd(cwd: string): void {
  requireText(cwd, 'cwd');
  if (isAbsolute(cwd) || win32.isAbsolute(cwd) || /^[A-Za-z]:/.test(cwd)) throw new IsolationError('INVALID_CWD', 'cwd must be relative');
  if (/[\\/]{2,}/.test(cwd) || cwd.split(/[\\/]/).some(part => part === '..')) throw new IsolationError('INVALID_CWD', 'cwd contains ambiguous separators or traversal');
}
function isContained(workspace: string, target: string): boolean {
  const remainder = relative(workspace, target);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${'/'}`) && !remainder.startsWith(`..${'\\'}`) && !isAbsolute(remainder) && !win32.isAbsolute(remainder));
}
function digest(hash: ReturnType<typeof createHash>, bytes: number, preview: Buffer): OutputDigest { return { bytes, sha256: hash.digest('hex'), preview: preview.toString('utf8') }; }
function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32' && child.pid !== undefined) {
    const treeKill = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
    if (!treeKill.error && treeKill.status === 0) return Promise.resolve();
    child.kill('SIGKILL');
    return Promise.resolve();
  }
  try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); }
  catch { child.kill('SIGTERM'); }
  return new Promise(resolveKill => {
    const forceKill = setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
      resolveKill();
    }, 100);
    forceKill.unref();
  });
}

export class ChildProcessIsolationRunner implements IsolationRunner {
  constructor(private readonly options: ChildProcessIsolationRunnerOptions = {}) {}
  async run(request: IsolatedExecutionRequest): Promise<IsolatedExecutionResult> {
    this.validateRequest(request);
    if (request.no_network.requested && this.options.strictNetwork === true) throw new IsolationError('NETWORK_ENFORCEMENT_UNAVAILABLE', 'OS-level network enforcement is unavailable');
    let workspace: string; let target: string;
    try { workspace = await realpath(request.workspace); target = await realpath(resolve(workspace, request.cwd)); }
    catch { throw new IsolationError('INVALID_WORKSPACE', 'workspace or cwd does not resolve to an existing path'); }
    if (!isContained(workspace, target)) throw new IsolationError('WORKSPACE_ESCAPE', 'cwd resolves outside workspace');
    const environment: Record<string, string> = { ...request.env, TNA_EXECUTION_ID: request.execution_id, TNA_TOOL_NAME: request.tool, TMP: workspace, TMPDIR: workspace, TEMP: workspace };
    const network = { requested: request.no_network.requested, mode: request.no_network.mode, enforcement: 'not-enforced' as const };
    const stdout = { hash: createHash('sha256'), bytes: 0, preview: Buffer.alloc(0) }; const stderr = { hash: createHash('sha256'), bytes: 0, preview: Buffer.alloc(0) };
    let totalBytes = 0; let termination: 'runtime_limit' | 'output_limit' | null = null; let terminationPromise: Promise<void> | null = null; let settled = false; let child: ChildProcess;
    try { child = spawn(request.command, [...request.args], { shell: false, cwd: target, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch { return this.failure(request, network, stdout, stderr); }
    const requestTermination = (reason: 'runtime_limit' | 'output_limit'): void => { termination ??= reason; if (!settled) terminationPromise ??= killChild(child); };
    const capture = (stream: NodeJS.ReadableStream | null, output: typeof stdout, limit: number): void => {
      stream?.on('data', (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); output.hash.update(data); output.bytes += data.length; totalBytes += data.length;
        const remaining = Math.max(0, limit - output.preview.length); if (remaining > 0) output.preview = Buffer.concat([output.preview, data.subarray(0, remaining)]);
        if (output.bytes > limit || totalBytes > request.output_limit_bytes) requestTermination('output_limit');
      });
    };
    capture(child.stdout, stdout, request.stdout_limit_bytes); capture(child.stderr, stderr, request.stderr_limit_bytes);
    const timer = setTimeout(() => requestTermination('runtime_limit'), request.runtime_limit_ms);
    const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; error: boolean }>(resolveOutcome => {
      child.once('error', () => resolveOutcome({ exitCode: null, signal: null, error: true }));
      child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => resolveOutcome({ exitCode, signal, error: false }));
    });
    settled = true; clearTimeout(timer); if (terminationPromise) await terminationPromise;
    const reason = termination ?? (outcome.error ? 'child_error' : outcome.exitCode === 0 ? 'completed' : 'non_zero_exit');
    return { execution_id: request.execution_id, state: termination ? 'TERMINATED' : reason === 'completed' ? 'SUCCEEDED' : 'FAILED', reason, exit_code: outcome.exitCode, signal: outcome.signal, stdout: digest(stdout.hash, stdout.bytes, stdout.preview), stderr: digest(stderr.hash, stderr.bytes, stderr.preview), network };
  }
  private validateRequest(request: IsolatedExecutionRequest): void {
    if (!request || typeof request !== 'object') throw new IsolationError('INVALID_REQUEST', 'request must be an object');
    for (const [value, field] of [[request.execution_id, 'execution_id'], [request.agent_id, 'agent_id'], [request.tool, 'tool'], [request.operation, 'operation'], [request.command, 'command'], [request.workspace, 'workspace']] as const) requireText(value, field);
    if (!Array.isArray(request.args) || request.args.some(argument => typeof argument !== 'string' || controlCharacter(argument))) throw new IsolationError('INVALID_REQUEST', 'args must be strings without control characters');
    validateCwd(request.cwd);
    for (const [value, field] of [[request.runtime_limit_ms, 'runtime_limit_ms'], [request.stdout_limit_bytes, 'stdout_limit_bytes'], [request.stderr_limit_bytes, 'stderr_limit_bytes'], [request.output_limit_bytes, 'output_limit_bytes']] as const) requireLimit(value, field, field !== 'runtime_limit_ms');
    if (!request.no_network || typeof request.no_network.requested !== 'boolean' || !['unrestricted', 'preflight-only'].includes(request.no_network.mode)) throw new IsolationError('INVALID_REQUEST', 'no_network metadata is invalid');
    if (!request.env || typeof request.env !== 'object' || Array.isArray(request.env)) throw new IsolationError('INVALID_ENVIRONMENT', 'env must be an object');
    for (const [key, value] of Object.entries(request.env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || forbiddenEnvironmentKey.test(key) || typeof value !== 'string' || controlCharacter(value)) throw new IsolationError('INVALID_ENVIRONMENT', `environment key is not allowed: ${key}`);
  }
  private failure(request: IsolatedExecutionRequest, network: IsolatedExecutionResult['network'], stdout: { hash: ReturnType<typeof createHash>; bytes: number; preview: Buffer }, stderr: { hash: ReturnType<typeof createHash>; bytes: number; preview: Buffer }): IsolatedExecutionResult {
    return { execution_id: request.execution_id, state: 'FAILED', reason: 'child_error', exit_code: null, signal: null, stdout: digest(stdout.hash, stdout.bytes, stdout.preview), stderr: digest(stderr.hash, stderr.bytes, stderr.preview), network };
  }
}
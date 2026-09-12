/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Section 77-79: `OperatorCommandResult
 * v1` — the one versioned, stable shape every CLI command emits in `--json` mode. Section 79: documented
 * deterministic exit codes.
 */
import { redactDeep } from './redact.js';

export type OperatorResultCode =
  | 'OK' | 'VALIDATION_ERROR' | 'FORBIDDEN' | 'UNAVAILABLE' | 'FAILED' | 'INDETERMINATE' | 'NOT_FOUND';

export interface OperatorCommandResult<T = unknown> {
  readonly version: '1.0';
  readonly ok: boolean;
  readonly code: OperatorResultCode;
  readonly summary: string;
  readonly data?: T;
  readonly warnings: readonly string[];
  /** Defaults to true (redacted). Set false ONLY for the one-time credential-issuance display that is
   * the entire purpose of `service create`/`service rotate` (section: "credential shown once", carried
   * forward from Volume 10) — every other command's output is always redacted before printing. */
  readonly sensitive?: boolean;
}

/** Section 79: deterministic exit codes, documented in `docs/operator/operator-cli-v0.1.md`. */
export const EXIT_CODES: Readonly<Record<OperatorResultCode, number>> = {
  OK: 0, VALIDATION_ERROR: 2, FORBIDDEN: 3, UNAVAILABLE: 4, FAILED: 5, INDETERMINATE: 6, NOT_FOUND: 7,
};

export function ok<T>(summary: string, data?: T, warnings: readonly string[] = [], options?: { readonly sensitive?: boolean }): OperatorCommandResult<T> {
  return { version: '1.0', ok: true, code: 'OK', summary, ...(data !== undefined ? { data } : {}), warnings, ...(options?.sensitive === false ? { sensitive: false as const } : {}) };
}
export function fail<T>(code: Exclude<OperatorResultCode, 'OK'>, summary: string, data?: T, warnings: readonly string[] = []): OperatorCommandResult<T> {
  return { version: '1.0', ok: false, code, summary, ...(data !== undefined ? { data } : {}), warnings };
}

/** Section 12: `--json` output is deep-redacted the same as human output — a machine consumer gets no
 * more secret exposure than a human reading the terminal would. */
export function printResult(result: OperatorCommandResult, jsonMode: boolean): void {
  const shouldRedact = result.sensitive !== false;
  const redacted = shouldRedact
    ? { ...result, data: result.data !== undefined ? redactDeep(result.data) : undefined, summary: redactDeep(result.summary) }
    : result;
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(redacted)}\n`);
    return;
  }
  const marker = result.ok ? '✓' : '✗';
  process.stdout.write(`${marker} ${redacted.summary as string}\n`);
  for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`);
  if (redacted.data !== undefined) process.stdout.write(`${JSON.stringify(redacted.data, null, 2)}\n`);
}

export function exitCodeFor(result: OperatorCommandResult): number {
  return EXIT_CODES[result.code];
}

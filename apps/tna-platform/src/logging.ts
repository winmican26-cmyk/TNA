import { redact } from '../../../packages/deployment-schema/src/index.js';

/**
 * Section 57-60: structured, single-line JSON logs with mandatory secret redaction. Deliberately does
 * not log raw tool/action input by default (section 58) — callers pass `input_hash`/bounded metadata,
 * never the input itself.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly component?: string;
  readonly tenant_id?: string;
  readonly platform_action_id?: string;
  readonly correlation_id?: string;
  readonly event?: string;
  readonly error_code?: string;
  readonly [key: string]: unknown;
}

export interface Logger { readonly log: (level: LogLevel, message: string, fields?: LogFields) => void }

export function createLogger(component: string, sink: (line: string) => void = line => process.stdout.write(line + '\n')): Logger {
  return {
    log(level, message, fields = {}) {
      const redacted = redact({ ...fields, component: fields.component ?? component }) as Record<string, unknown>;
      sink(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...redacted }));
    },
  };
}

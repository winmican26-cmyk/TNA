/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Section 12, 84: CLI output and incident
 * packages must never print raw credentials, tokens, private keys, secret environment variables, or
 * authorization headers. Reuses `packages/deployment-schema`'s accepted `findSecretShapedField`-style
 * detection algorithm (same fixed rule set already proven for Volumes 9-10), applied here at the output
 * boundary rather than at the input-validation boundary.
 */

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|authorization|credential|signing[_-]?key|token)/i;
const BEARER_VALUE_PATTERN = /Bearer\s+\S+/i;
const LONG_OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,}$/;

export const REDACTED = '[REDACTED]';

/** Deep-clones `value`, replacing any object field whose *name* looks secret-shaped, and any *string
 * value* that itself looks like a bearer header or a long opaque token, with `[REDACTED]`. Used on every
 * value the CLI prints and on every field written into an incident package. */
export function redactDeep(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string') {
    if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) return REDACTED;
    if (BEARER_VALUE_PATTERN.test(value)) return REDACTED;
    if (keyHint && /token|secret|credential|password|key/i.test(keyHint) && LONG_OPAQUE_TOKEN_PATTERN.test(value)) return REDACTED;
    return value;
  }
  if (Array.isArray(value)) return value.map(entry => redactDeep(entry));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactDeep(entryValue, key);
    }
    return out;
  }
  return value;
}

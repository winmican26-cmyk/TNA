import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export type Principal = { kind: 'admin' | 'approver'; role: string } | { kind: 'agent'; agentId: string };
export function issueToken(): string { return randomBytes(32).toString('base64url'); }
export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function equalToken(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(tokenHash(a), 'hex'), Buffer.from(tokenHash(b), 'hex'));
}

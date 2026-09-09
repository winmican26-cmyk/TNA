import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CapabilityCodec, CapabilityError, type CapabilityInput } from '../../packages/capability-core/src/index.js';

const secret = Buffer.alloc(32, 7);
const input: CapabilityInput = {
  capability_id: 'cap-1', execution_id: 'exec-1', agent_id: 'agent-1', decision_id: 'decision-1',
  action: 'deploy', tool: 'deploy.execute', resource: 'prod.release', operation: 'write',
  destination: 'deploy.internal.company', policy_hash: 'hash-1', policy_issuance_id: 'issuance-1',
};

function codec(now = Date.parse('2026-09-09T12:00:00.000Z'), options: { ttlSeconds?: number } = {}) {
  return new CapabilityCodec(secret, { clock: () => now, ...options });
}

function expectCapabilityError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof CapabilityError);
}

function alternateBase64urlSpelling(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const decoded = Buffer.from(value, 'base64url');
  const lastIndex = value.length - 1;
  for (const character of alphabet) {
    const candidate = `${value.slice(0, lastIndex)}${character}`;
    if (candidate !== value && Buffer.from(candidate, 'base64url').equals(decoded)) return candidate;
  }
  throw new Error('No alternate base64url spelling found');
}

test('issues and verifies a canonical single-use capability', () => {
  const result = codec().issue(input);
  assert.equal(codec().verify(result.token).nonce, result.payload.nonce);
  assert.equal(result.payload.version, 1);
  assert.equal(result.payload.single_use, true);
  assert.equal(result.payload.expires_at, '2026-09-09T12:00:30.000Z');
});

test('rejects token modification and forgery', () => {
  const issued = codec().issue(input);
  const [encodedPayload, encodedMac] = issued.token.split('.');
  expectCapabilityError(() => codec().verify(`${encodedPayload}A.${encodedMac}`));
  const forged = `${Buffer.from(JSON.stringify({ ...issued.payload, action: 'delete' })).toString('base64url')}.${encodedMac}`;
  expectCapabilityError(() => codec().verify(forged));
});

test('rejects non-canonical base64url spellings', () => {
  const issued = codec().issue(input);
  const [encodedPayload, encodedMac] = issued.token.split('.');
  const alternatePayload = alternateBase64urlSpelling(encodedPayload!);
  const alternateMac = alternateBase64urlSpelling(encodedMac!);
  expectCapabilityError(() => codec().verify(`${alternatePayload}.${encodedMac}`));
  expectCapabilityError(() => codec().verify(`${encodedPayload}.${alternateMac}`));
});

test('rejects malformed and unknown-version tokens', () => {
  for (const token of ['', 'one', 'a.b.c', '%%%.__']) expectCapabilityError(() => codec().verify(token));
  const issued = codec().issue(input);
  const payload = JSON.parse(Buffer.from(issued.token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  payload.version = 2;
  const bytes = Buffer.from(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(bytes).digest('base64url');
  expectCapabilityError(() => codec().verify(`${bytes.toString('base64url')}.${mac}`));
});

test('validates the minimum secret length', () => {
  expectCapabilityError(() => new CapabilityCodec(Buffer.alloc(31)));
});

test('rejects future-issued and overlong capabilities', () => {
  const future = new CapabilityCodec(secret, { clock: () => Date.parse('2026-09-09T12:00:00.000Z') + 1 });
  const futureIssued = future.issue(input);
  expectCapabilityError(() => codec().verify(futureIssued.token));

  const issued = codec().issue(input);
  const payload = JSON.parse(Buffer.from(issued.token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  payload.expires_at = '2026-09-09T12:01:01.000Z';
  const bytes = Buffer.from(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(bytes).digest('base64url');
  expectCapabilityError(() => codec().verify(`${bytes.toString('base64url')}.${mac}`));
});

test('rejects non-canonical timestamps', () => {
  const issued = codec().issue(input);
  const payload = JSON.parse(Buffer.from(issued.token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  payload.issued_at = '2026-02-30T12:00:00.000Z';
  const bytes = Buffer.from(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(bytes).digest('base64url');
  expectCapabilityError(() => codec().verify(`${bytes.toString('base64url')}.${mac}`));
});

test('rejects expired capabilities and caps requested expiry', () => {
  const issued = codec().issue({ ...input, expires_at: '2026-09-09T12:00:50.000Z' });
  assert.equal(issued.payload.expires_at, '2026-09-09T12:00:30.000Z');
  expectCapabilityError(() => codec(Date.parse('2026-09-09T12:00:30.000Z')).verify(issued.token));
  expectCapabilityError(() => codec().issue({ ...input, expires_at: '2026-09-09T11:59:59.000Z' }));
});

test('enforces the constructor TTL cap and canonicalization', () => {
  expectCapabilityError(() => new CapabilityCodec(secret, { ttlSeconds: 61 }));
  const first = codec().issue(input);
  const second = codec().issue({ ...input });
  const firstPayload = Buffer.from(first.token.split('.')[0]!, 'base64url').toString('utf8');
  const secondPayload = Buffer.from(second.token.split('.')[0]!, 'base64url').toString('utf8');
  assert.equal(firstPayload.startsWith('{"action":"deploy","agent_id":"agent-1","capability_id":"cap-1","decision_id":"decision-1","destination":"deploy.internal.company","execution_id":"exec-1","expires_at":"2026-09-09T12:00:30.000Z","issued_at":"2026-09-09T12:00:00.000Z","nonce":'), true);
  assert.equal(firstPayload.slice(0, firstPayload.indexOf('"nonce"')), secondPayload.slice(0, secondPayload.indexOf('"nonce"')));
});

test('binds every payload field to the MAC', () => {
  const issued = codec().issue(input);
  const payload = JSON.parse(Buffer.from(issued.token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    version: 2, capability_id: 'cap-2', execution_id: 'exec-2', agent_id: 'agent-2', decision_id: 'decision-2',
    action: 'delete', tool: 'delete.execute', resource: 'prod.rollback', operation: 'read', destination: null,
    policy_hash: 'hash-2', policy_issuance_id: 'issuance-2', issued_at: '2026-09-09T12:00:01.000Z',
    expires_at: '2026-09-09T12:00:31.000Z', single_use: false, nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
  };
  const mac = issued.token.split('.')[1]!;
  for (const [key, replacement] of Object.entries(replacements)) {
    const tampered = { ...payload, [key]: replacement };
    const bytes = Buffer.from(JSON.stringify(tampered));
    expectCapabilityError(() => codec().verify(`${bytes.toString('base64url')}.${mac}`));
  }
});

test('does not include the secret in the payload or token', () => {
  const result = codec().issue(input);
  assert.equal(JSON.stringify(result.payload).includes(secret.toString('hex')), false);
  assert.equal(result.token.includes(secret.toString('utf8')), false);
});
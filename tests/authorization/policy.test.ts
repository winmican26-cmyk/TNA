import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, request, NOW } from '../fixture.js';
import { envelopeSchema, hash } from '../../packages/authority-envelope/src/index.js';
import { requestSchema } from '../../packages/shared-schema/src/index.js';
import { evaluate, type PolicyContext } from '../../packages/policy-engine/src/index.js';

export const context = (): PolicyContext => ({ now: NOW, revoked: false, approvalValid: true,
  knownAgents: new Set(['security-verifier']), usage: { startedAt: null, calls: 0, external: 0, costMicros: 0, attempts: {} } });
test('strict envelope accepts the versioned fixture', () => assert.deepEqual(envelopeSchema.parse(envelope()), envelope()));
test('canonical policy hash ignores object key insertion order', () => assert.equal(hash({ b: 1, a: 2 }), hash({ a: 2, b: 1 })));
test('valid request allows deterministically without mutation', () => {
  const e = envelope(), r = request(), c = context();
  const before = JSON.stringify({ e, r, c });
  assert.equal(evaluate(r, e, c).decision, 'ALLOW');
  assert.equal(JSON.stringify({ e, r, c }), before);
});
test('absent approval holds', () => assert.equal(evaluate(request(), envelope(), { ...context(), approvalValid: false }).decision, 'HOLD'));
for (const [name, change] of Object.entries({
  'unknown root fields': (e: Record<string, unknown>) => { e.unknown = true; },
  'unknown nested fields': (e: Record<string, unknown>) => { (e.agent as Record<string, unknown>).admin = true; },
  'unsupported version': (e: Record<string, unknown>) => { e.version = '2.0'; },
})) test(`rejects ${name}`, () => { const e = envelope(); change(e); assert.equal(envelopeSchema.safeParse(e).success, false); });
test('rejects ambiguous or forbidden action bindings', () => {
  const e = envelope(); e.action_bindings.push(e.action_bindings[0]!);
  assert.equal(envelopeSchema.safeParse(e).success, false);
  const other = envelope(); other.action_bindings[0]!.outcome = 'modify application source';
  assert.equal(envelopeSchema.safeParse(other).success, false);
});
test('rejects malformed costs and destinations', () => {
  for (const cost of [-1, Infinity, NaN, '0', null]) assert.equal(requestSchema.safeParse({ ...request(), estimatedCostUsd: cost }).success, false);
  for (const destination of ['https://deploy.internal.company', 'deploy.internal.company:443', 'deploy.internal.company@evil.com', 'DEPLOY.internal.company', 'deploy.internal.company.']) assert.equal(requestSchema.safeParse({ ...request(), destination }).success, false);
});

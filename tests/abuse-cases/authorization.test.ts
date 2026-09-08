import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, request, NOW } from '../fixture.js';
import { evaluate, type PolicyContext } from '../../packages/policy-engine/src/index.js';
import type { AuthorizationRequest } from '../../packages/shared-schema/src/index.js';
const context = (): PolicyContext => ({ now: NOW, revoked: false, approvalValid: true, knownAgents: new Set(['security-verifier']), usage: { startedAt: null, calls: 0, external: 0, costMicros: 0, attempts: {} } });
const cases: [string, Partial<AuthorizationRequest>][] = [
  ['forbidden shell', { tool: 'shell.unrestricted' }],
  ['unlisted tool', { tool: 'unknown.tool' }],
  ['undeclared resource', { resource: 'prod.admin' }],
  ['unknown host', { destination: 'evil.example' }],
  ['host suffix spoof', { destination: 'deploy.internal.company.evil.example' }],
  ['objective reinterpretation', { action: 'source.modify' }],
  ['self envelope edit', { action: 'envelope.update' }],
  ['read permission used for write', { resource: 'prod.cluster.status' }],
  ['unknown agent contact', { action: 'agent.contact', tool: 'agent.send', resource: 'unknown-agent' }],
  ['secret access fails closed without broker', { action: 'secret.access', tool: 'secret.read', resource: 'prod_deploy_token' }],
];
for (const [name, patch] of cases) test(name, () => assert.equal(evaluate({ ...request(), ...patch }, envelope(), context()).decision, 'BLOCK'));
for (const resource of ['/etc/passwd', '/workspace/logs/../secrets/key', '/workspace/logs-evil/file', '/workspace/logs/%2e%2e/secret', '/workspace/logs/a\\..\\key', '/workspace/logs//a', '/workspace/logs/./a', '/workspace/logs/file\u0000']) {
  test(`blocks file escape ${JSON.stringify(resource)}`, () => assert.equal(evaluate({ ...request(), action: 'log.write', tool: 'log.write', resource }, envelope(), context()).decision, 'BLOCK'));
}
test('allows canonical file in writable subtree', () => assert.equal(evaluate({ ...request(), action: 'log.write', tool: 'log.write', resource: '/workspace/logs/deploy.log' }, envelope(), context()).decision, 'ALLOW'));
test('missing network destination cannot bypass host check', () => { const { destination: _destination, ...r } = request(); void _destination; assert.equal(evaluate(r, envelope(), context()).decision, 'BLOCK'); });
test('explicit host deny overrides allow; wildcard means deny unlisted', () => { const e = envelope(); e.network.deny.push('deploy.internal.company'); assert.equal(evaluate(request(), e, context()).decision, 'BLOCK'); });
test('expired at exact expiry boundary', () => { const e = envelope(); e.agent.expires_at = new Date(NOW).toISOString(); assert.equal(evaluate(request(), e, context()).decision, 'BLOCK'); });
test('revoked identity blocks', () => assert.equal(evaluate(request(), envelope(), { ...context(), revoked: true }).decision, 'BLOCK'));
test('missing envelope blocks', () => assert.equal(evaluate(request(), null, context()).decision, 'BLOCK'));
test('cost ceiling holds including reserved spending', () => { const c = context(); c.usage.costMicros = 2_900_000; assert.equal(evaluate(request(), envelope(), c).decision, 'HOLD'); });
test('exact cost ceiling permits', () => { const c = context(); c.usage.costMicros = 2_880_000; assert.equal(evaluate(request(), envelope(), c).decision, 'ALLOW'); });
test('runtime boundary blocks', () => { const c = context(); c.usage.startedAt = new Date(NOW - 600_000).toISOString(); assert.equal(evaluate(request(), envelope(), c).decision, 'BLOCK'); });
test('tool call ceiling blocks', () => { const c = context(); c.usage.calls = 40; assert.equal(evaluate(request(), envelope(), c).decision, 'BLOCK'); });
test('external request ceiling blocks', () => { const c = context(); c.usage.external = 20; assert.equal(evaluate(request(), envelope(), c).decision, 'BLOCK'); });
test('retry ceiling blocks', () => { const c = context(); c.usage.attempts['production.deploy'] = 3; assert.equal(evaluate(request(), envelope(), c).decision, 'BLOCK'); });
test('listed agent must also be registered', () => { const c = context(); c.knownAgents = new Set(); assert.equal(evaluate({ ...request(), action: 'agent.contact', tool: 'agent.send', resource: 'security-verifier' }, envelope(), c).decision, 'BLOCK'); });

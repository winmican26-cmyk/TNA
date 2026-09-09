import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CapabilityCodec, CapabilityError, type CapabilityInput } from '../../packages/capability-core/src/index.js';
import { ToolInputError, ToolInputRegistry, demoToolInputMetadata } from '../../packages/tool-inputs/src/index.js';

const secret = Buffer.alloc(32, 9);
const capabilityInput: CapabilityInput = {
  capability_id: 'cap-tool-input', execution_id: 'exec-tool-input', agent_id: 'agent-1', decision_id: 'decision-1',
  action: 'production.deploy', tool: 'demo.deploy.execute', resource: 'release-1', operation: 'write', destination: null,
  policy_hash: 'policy-1', policy_issuance_id: 'issuance-1', input_hash: 'a'.repeat(64),
};

function registry(): ToolInputRegistry {
  const value = new ToolInputRegistry();
  value.register(demoToolInputMetadata);
  return value;
}

function codec(): CapabilityCodec {
  return new CapabilityCodec(secret, { clock: () => Date.parse('2026-09-09T12:00:00.000Z') });
}

function expectCapabilityError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof CapabilityError);
}

test('strictly validates demo deploy input and rejects executable selection', () => {
  const value = registry();
  assert.throws(() => value.parseAndHash('demo.deploy.execute', { release: 'release-1', environment: 'demo-production', command: 'rm -rf /' }), ToolInputError);
  assert.throws(() => value.parseAndHash('demo.deploy.execute', { release: 'release-1; rm -rf /', environment: 'demo-production' }), ToolInputError);
  assert.throws(() => value.parseAndHash('demo.deploy.execute', { release: 'release-1', environment: 'production' }), ToolInputError);
  assert.throws(() => value.parseAndHash('demo.deploy.execute', { release: 'release-1', environment: 'demo-production', executable: 'sh' }), ToolInputError);
});

test('canonicalizes key order and binds the exact validated input', () => {
  const value = registry();
  const first = value.parseAndHash('demo.deploy.execute', { environment: 'demo-production', release: 'release-1' });
  const second = value.parseAndHash('demo.deploy.execute', { release: 'release-1', environment: 'demo-production' });
  assert.equal(first.canonical, '{"environment":"demo-production","release":"release-1"}');
  assert.equal(first.input_hash, second.input_hash);
  assert.equal(value.verifyHash('demo.deploy.execute', { release: 'release-1', environment: 'demo-production' }, first.input_hash), true);
  assert.equal(value.verifyHash('demo.deploy.execute', { release: 'release-2', environment: 'demo-production' }, first.input_hash), false);
});

test('rejects malformed, oversized, and unknown tool input', () => {
  const value = registry();
  assert.throws(() => value.parseAndHash('demo.deploy.execute', { release: 'x'.repeat(70), environment: 'demo-production' }), ToolInputError);
  assert.throws(() => value.parseAndHash('demo.deploy.execute', { release: 'release-1', environment: 'demo-production', extra: 'x' }), ToolInputError);
  assert.throws(() => value.parseAndHash('demo.deploy.execute', { release: 'release-1', environment: 'demo-production', padding: 'x'.repeat(300) }), ToolInputError);
  assert.throws(() => value.parseAndHash('missing.tool', { release: 'release-1', environment: 'demo-production' }), ToolInputError);
  assert.equal(value.verifyHash('demo.deploy.execute', { release: 'release-1', environment: 'demo-production' }, 'not-a-hash'), false);
});

test('registry metadata is server-owned and contains no executable handler', () => {
  const metadata = registry().get('demo.deploy.execute');
  assert.ok(metadata);
  assert.equal('handler' in metadata, false);
  assert.equal(metadata.networkRequired, false);
  assert.equal(metadata.operation, 'write');
  assert.equal(metadata.resourceType, 'infrastructure');
});

test('input_hash is MAC-bound and substitution cannot verify', () => {
  const issued = codec().issue(capabilityInput);
  const payload = JSON.parse(Buffer.from(issued.token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  payload.input_hash = 'b'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(payload));
  const mac = issued.token.split('.')[1]!;
  expectCapabilityError(() => codec().verify(`${bytes.toString('base64url')}.${mac}`));

});

test('capability tokens without input_hash fail verification', () => {
  const issued = codec().issue(capabilityInput);
  const payload = JSON.parse(Buffer.from(issued.token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  delete payload.input_hash;
  const bytes = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)))));
  const mac = createHmac('sha256', secret).update(bytes).digest('base64url');
  expectCapabilityError(() => codec().verify(`${bytes.toString('base64url')}.${mac}`));
});

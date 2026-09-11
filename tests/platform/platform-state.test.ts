import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { PlatformError } from '../../packages/platform-schema/src/index.js';
import { PlatformStore } from '../../packages/platform-core/src/index.js';

const request = (requestId = 'req_1') => ({ version: '1.0', request_id: requestId, tenant_id: 'tenant_a', agent_id: 'agent_a', action: 'echo', tool: 'demo.echo', operation: 'execute', resource: 'demo', input: { message: 'hello' }, requires_verification: false });
function store(): { dir: string; path: string; store: PlatformStore } { const dir = mkdtempSync(resolve(tmpdir(), 'platform-state-')); const path = resolve(dir, 'platform.sqlite'); return { dir, path, store: new PlatformStore(path, { clock: () => Date.parse('2026-01-01T00:00:00.000Z') }) }; }

test('platform action creation is tenant-scoped, idempotent, strict, and emits durable evidence', () => {
  const fixture = store(); try {
    const first = fixture.store.createOrReturn(request(), 'service_a');
    assert.equal(fixture.store.createOrReturn(request(), 'service_a').platform_action_id, first.platform_action_id);
    assert.throws(() => fixture.store.createOrReturn({ ...request(), input: { message: 'different' } }, 'service_a'), (error: unknown) => error instanceof PlatformError && error.code === 'CONFLICT');
    assert.throws(() => fixture.store.createOrReturn({ ...request('req_2'), invented: true }, 'service_a'), (error: unknown) => error instanceof PlatformError && error.code === 'INVALID_INPUT');
    assert.throws(() => fixture.store.get('tenant_b', first.platform_action_id), (error: unknown) => error instanceof PlatformError && error.code === 'NOT_FOUND');
    assert.equal(fixture.store.listOutbox('tenant_a', first.platform_action_id).length, 1);
  } finally { fixture.store.close(); rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('state CAS allows one execution claim and restart preserves uncertainty as INDETERMINATE', () => {
  const fixture = store(); try {
    const action = fixture.store.createOrReturn(request(), 'service_a');
    const authorizing = fixture.store.transition('tenant_a', action.platform_action_id, 0, 'AUTHORIZING');
    const authorized = fixture.store.transition('tenant_a', action.platform_action_id, authorizing.state_version, 'AUTHORIZED');
    const capability = fixture.store.transition('tenant_a', action.platform_action_id, authorized.state_version, 'CAPABILITY_ISSUED');
    const monitoring = fixture.store.transition('tenant_a', action.platform_action_id, capability.state_version, 'MONITORING');
    fixture.store.claimExecution('tenant_a', action.platform_action_id, monitoring.state_version, 'exec_one');
    assert.throws(() => fixture.store.claimExecution('tenant_a', action.platform_action_id, monitoring.state_version, 'exec_two'), (error: unknown) => error instanceof PlatformError && error.code === 'CONFLICT');
    fixture.store.close();
    const reopened = new PlatformStore(fixture.path, { clock: () => Date.parse('2026-01-01T00:00:01.000Z') });
    assert.equal(reopened.get('tenant_a', action.platform_action_id).state, 'INDETERMINATE');
    assert.ok(reopened.listOutbox('tenant_a', action.platform_action_id).some(record => record.event_type === 'PLATFORM_EXECUTION_INDETERMINATE_RECOVERY'));
    reopened.close();
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

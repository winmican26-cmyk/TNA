import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../../apps/tna-platform/src/logging.js';
import { buildPlatformMetrics } from '../../packages/deployment-health/src/index.js';

/** Section 57-60: structured logging must never leak a secret, regardless of which field carried it —
 * a name-shaped match (`admin_token`) or a value-shaped match (a bearer-token string in an unrelated
 * field) must both be caught. */
test('logger emits single-line structured JSON with mandatory timestamp/level/component/message fields', () => {
  const lines: string[] = [];
  const logger = createLogger('test-component', line => lines.push(line));
  logger.log('info', 'something happened', { event: 'TEST_EVENT', platform_action_id: 'pa_1', correlation_id: 'corr_1' });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.message, 'something happened');
  assert.equal(parsed.component, 'test-component');
  assert.equal(parsed.event, 'TEST_EVENT');
  assert.equal(parsed.platform_action_id, 'pa_1');
  assert.ok(typeof parsed.timestamp === 'string' && !Number.isNaN(Date.parse(parsed.timestamp as string)));
});

test('logger redacts a secret-shaped field name even when nested inside arbitrary log fields', () => {
  const lines: string[] = [];
  const logger = createLogger('test-component', line => lines.push(line));
  logger.log('warn', 'config issue', { event: 'CONFIG', admin_token: 'super-secret-value-do-not-log', nested: { signing_key: 'also-secret' } });
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(parsed.admin_token, '[REDACTED]');
  assert.equal((parsed.nested as Record<string, unknown>).signing_key, '[REDACTED]');
  assert.ok(!lines[0]!.includes('super-secret-value-do-not-log'));
});

test('logger redacts a bearer-token-shaped value even under an innocuous field name', () => {
  const lines: string[] = [];
  const logger = createLogger('test-component', line => lines.push(line));
  logger.log('error', 'auth failure', { event: 'AUTH_FAILED', note: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret-payload' });
  assert.ok(!lines[0]!.includes('eyJhbGciOiJIUzI1NiJ9'));
});

test('metrics gauges/counters never carry a request/action/tenant-scoped label — bounded cardinality regardless of traffic volume', () => {
  const metrics = buildPlatformMetrics();
  for (let i = 0; i < 500; i += 1) metrics.inc('actions_received_total');
  const text = metrics.renderPrometheus();
  const lines = text.split('\n').filter(l => l.startsWith('actions_received_total'));
  assert.equal(lines.length, 1, 'one metric line regardless of how many actions were processed');
  assert.equal(lines[0], 'actions_received_total 500');
});

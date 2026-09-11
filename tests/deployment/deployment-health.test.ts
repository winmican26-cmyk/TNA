import assert from 'node:assert/strict';
import test from 'node:test';
import { liveness, aggregateReadiness, runProbe, buildPlatformMetrics, MetricsRegistry, type ComponentHealth } from '../../packages/deployment-health/src/index.js';

test('liveness reports live and a non-negative uptime, never conflated with readiness', () => {
  const startedAt = Date.now() - 5000;
  const result = liveness(startedAt, () => startedAt + 5000);
  assert.equal(result.live, true);
  assert.equal(result.uptime_seconds, 5);
});

test('all components available -> ready and AVAILABLE', () => {
  const components: ComponentHealth[] = [
    { component: 'platform_store', status: 'AVAILABLE', mandatory: true, latency_ms: 1 },
    { component: 'gate', status: 'AVAILABLE', mandatory: true, latency_ms: 1 },
  ];
  const result = aggregateReadiness(components);
  assert.equal(result.ready, true);
  assert.equal(result.status, 'AVAILABLE');
});

test('optional component unavailable -> still ready, but overall DEGRADED (Auditor example)', () => {
  const components: ComponentHealth[] = [
    { component: 'platform_store', status: 'AVAILABLE', mandatory: true, latency_ms: 1 },
    { component: 'gate', status: 'AVAILABLE', mandatory: true, latency_ms: 1 },
    { component: 'auditor', status: 'UNAVAILABLE', mandatory: false, latency_ms: 1 },
  ];
  const result = aggregateReadiness(components);
  assert.equal(result.ready, true, 'execution readiness must not require the optional post-hoc Auditor');
  assert.equal(result.status, 'DEGRADED');
});

test('mandatory component unavailable -> not ready, UNAVAILABLE (Sentinel example)', () => {
  const components: ComponentHealth[] = [
    { component: 'platform_store', status: 'AVAILABLE', mandatory: true, latency_ms: 1 },
    { component: 'sentinel', status: 'UNAVAILABLE', mandatory: true, latency_ms: 1 },
  ];
  const result = aggregateReadiness(components);
  assert.equal(result.ready, false, 'a mandatory dependency outage must fail readiness closed');
  assert.equal(result.status, 'UNAVAILABLE');
});

test('runProbe converts a thrown error into UNAVAILABLE with a bounded message, never a raw stack', () => {
  return runProbe('flaky', true, () => { throw new Error('connection refused to some internal address with secret=abc123'.repeat(20)); }).then(result => {
    assert.equal(result.status, 'UNAVAILABLE');
    assert.ok(result.message !== undefined && result.message.length <= 200);
  });
});

test('runProbe reports AVAILABLE with latency when the probe succeeds', async () => {
  const result = await runProbe('fast', true, () => undefined);
  assert.equal(result.status, 'AVAILABLE');
  assert.ok(result.latency_ms >= 0);
});

test('metrics registry: counters increment, gauges set, unknown metric names rejected', () => {
  const metrics = new MetricsRegistry();
  metrics.counter('widgets_total', 'widgets processed');
  metrics.gauge('queue_depth', 'items waiting');
  metrics.inc('widgets_total');
  metrics.inc('widgets_total', 4);
  metrics.set('queue_depth', 7);
  assert.equal(metrics.value('widgets_total'), 5);
  assert.equal(metrics.value('queue_depth'), 7);
  assert.throws(() => metrics.inc('nonexistent_total'));
  assert.throws(() => metrics.set('widgets_total', 1), 'a counter must not accept .set()');
});

test('renderPrometheus output carries no per-request/per-action labels (bounded cardinality)', () => {
  const metrics = buildPlatformMetrics();
  metrics.inc('actions_received_total');
  const text = metrics.renderPrometheus();
  assert.ok(text.includes('actions_received_total 1'));
  assert.ok(!/\{.*\}/.test(text), 'no metric line should carry a label set — cardinality must stay fixed');
});

test('buildPlatformMetrics defines exactly the fixed section-61 metric set', () => {
  const metrics = buildPlatformMetrics();
  for (const name of ['actions_received_total', 'actions_blocked_total', 'actions_completed_total', 'actions_indeterminate_total', 'sentinel_terminations_total', 'outbox_pending', 'outbox_dead_letter', 'outbox_delivery_failures_total', 'ledger_delivery_latency_ms', 'audits_started_total', 'audits_failed_total']) {
    assert.equal(metrics.value(name), 0);
  }
});

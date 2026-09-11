/**
 * TNA Deployment Engineering v0.1 (Volume 9). Liveness/readiness aggregation and a minimal, bounded
 * metrics registry (section 31-34, 61-63). Deliberately has no import of any accepted TNA component —
 * it is handed small probe functions by the app composition root and only aggregates their results, so
 * it cannot itself observe (or leak) anything beyond what each probe explicitly returns (TNA-52:
 * "Readiness is a security decision," not a bypass around one).
 */

export type ComponentStatus = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';

export interface ComponentHealth {
  readonly component: string;
  readonly status: ComponentStatus;
  readonly mandatory: boolean;
  readonly latency_ms: number;
  readonly message?: string;
}

export type HealthProbe = () => ComponentHealth | Promise<ComponentHealth>;

/** Runs a single probe with a wall-clock latency measurement, converting a thrown error into an
 * UNAVAILABLE result rather than letting one failing dependency crash the whole readiness check. Never
 * includes the raw error object/stack in the result — only a bounded message (section 34). */
export async function runProbe(component: string, mandatory: boolean, probe: () => unknown | Promise<unknown>): Promise<ComponentHealth> {
  const start = performance.now();
  try {
    const outcome = await probe();
    const latency_ms = Math.round(performance.now() - start);
    if (outcome && typeof outcome === 'object' && 'status' in outcome) return outcome as ComponentHealth;
    return { component, status: 'AVAILABLE', mandatory, latency_ms };
  } catch (error) {
    const latency_ms = Math.round(performance.now() - start);
    const message = error instanceof Error ? error.message.slice(0, 200) : 'probe failed';
    return { component, status: 'UNAVAILABLE', mandatory, latency_ms, message };
  }
}

export interface LivenessResult {
  readonly live: true;
  readonly uptime_seconds: number;
}
export interface ReadinessResult {
  readonly ready: boolean;
  readonly status: ComponentStatus;
  readonly components: readonly ComponentHealth[];
}

/** Liveness only means "the process can answer" — section 31: never conflated with readiness. */
export function liveness(startedAt: number, now: () => number = Date.now): LivenessResult {
  return { live: true, uptime_seconds: Math.max(0, Math.round((now() - startedAt) / 1000)) };
}

/**
 * A mandatory component (Gate, the platform's own store, Sentinel when policy requires it) being
 * unavailable makes the whole deployment NOT READY. An optional component (Auditor) being unavailable
 * only degrades the overall status — ordinary governed-action execution may remain READY while the
 * audit feature itself is reported DEGRADED (section 32-33).
 */
export function aggregateReadiness(components: readonly ComponentHealth[]): ReadinessResult {
  const mandatoryDown = components.some(c => c.mandatory && c.status === 'UNAVAILABLE');
  const anyDegraded = components.some(c => c.status !== 'AVAILABLE');
  const status: ComponentStatus = mandatoryDown ? 'UNAVAILABLE' : anyDegraded ? 'DEGRADED' : 'AVAILABLE';
  return { ready: !mandatoryDown, status, components };
}

// ---------------------------------------------------------------------------------------------
// Metrics (section 61-63). Counters/gauges only, no per-request/per-action/per-tenant label —
// cardinality is fixed at build time, never grows with traffic (section 62).
// ---------------------------------------------------------------------------------------------

export type MetricKind = 'counter' | 'gauge';
interface MetricDef { readonly kind: MetricKind; readonly help: string }

export class MetricsRegistry {
  private readonly defs = new Map<string, MetricDef>();
  private readonly values = new Map<string, number>();

  public counter(name: string, help: string): void { this.define(name, 'counter', help); }
  public gauge(name: string, help: string): void { this.define(name, 'gauge', help); }
  private define(name: string, kind: MetricKind, help: string): void {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid metric name: ${name}`);
    if (this.defs.has(name)) return;
    this.defs.set(name, { kind, help });
    this.values.set(name, 0);
  }
  public inc(name: string, by = 1): void {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Unknown metric: ${name}`);
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }
  public set(name: string, value: number): void {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Unknown metric: ${name}`);
    if (def.kind !== 'gauge') throw new Error(`Metric ${name} is not a gauge`);
    this.values.set(name, value);
  }
  public value(name: string): number { return this.values.get(name) ?? 0; }
  public snapshot(): Readonly<Record<string, number>> { return Object.fromEntries(this.values); }

  /** Prometheus text exposition format (section 63). Every metric carries no labels at all — bounded
   * cardinality by construction, not by convention. */
  public renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, def] of this.defs) {
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} ${def.kind}`);
      lines.push(`${name} ${this.values.get(name) ?? 0}`);
    }
    return lines.join('\n') + '\n';
  }
}

/** The fixed metric set this milestone actually wires up (section 61) — declared once so both the app
 * composition root and tests reference the same names. */
export function buildPlatformMetrics(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.counter('actions_received_total', 'Governed actions received by this process');
  m.counter('actions_blocked_total', 'Governed actions blocked by Gate');
  m.counter('actions_completed_total', 'Governed actions that reached COMPLETED');
  m.counter('actions_indeterminate_total', 'Governed actions that reached INDETERMINATE');
  m.counter('sentinel_terminations_total', 'Actions terminated by Sentinel mid-flight');
  m.gauge('outbox_pending', 'Outbox records not yet delivered');
  m.gauge('outbox_dead_letter', 'Outbox records exhausted into DEAD_LETTER');
  m.counter('outbox_delivery_failures_total', 'Outbox delivery attempts that failed');
  m.gauge('ledger_delivery_latency_ms', 'Most recent observed outbox-to-Ledger delivery latency');
  m.counter('audits_started_total', 'Post-hoc audit assessments started');
  m.counter('audits_failed_total', 'Post-hoc audit assessments that failed to complete');
  return m;
}

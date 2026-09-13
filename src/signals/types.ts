/**
 * Metrics + trace provider ports (OpenTelemetry traces, Prometheus/Grafana,
 * Datadog/New Relic adapters all satisfy these) plus the investigator's
 * cross-signal summarizer: p99 latency + error rate + trace waterfall + logs.
 */
export interface MetricPoint {
  ts: number;
  value: number;
}

export interface MetricSeries {
  name: string;
  /** e.g. "p99_latency_ms", "error_rate", "p95_latency_ms". */
  kind: string;
  service?: string;
  points: MetricPoint[];
}

export interface TraceSpan {
  spanId: string;
  traceId: string;
  service: string;
  operation: string;
  /** ms. */
  durationMs: number;
  /** Epoch ms span start. */
  ts: number;
  status: 'ok' | 'error';
  parentSpanId?: string;
}

export interface TraceSample {
  traceId: string;
  spans: TraceSpan[];
}

export interface MetricsProvider {
  readonly name: string;
  query(service: string, kind: string, from: number, to: number): Promise<MetricSeries>;
}

export interface TraceProvider {
  readonly name: string;
  /** Failed-trace sample for a service in a window. */
  failedTraces(service: string, from: number, to: number, limit?: number): Promise<TraceSample[]>;
}

export interface CrossSignalSummary {
  service: string;
  window: { from: number; to: number };
  errorRate?: number;
  p99LatencyMs?: number;
  failedTraceCount: number;
  /** Share of failed traces entering this dependency (0..1). */
  dependencyEntryShare: Record<string, number>;
  waterfallNote: string;
}

function lastValue(series: MetricSeries | undefined): number | undefined {
  if (!series || series.points.length === 0) return undefined;
  return series.points[series.points.length - 1]?.value;
}

/**
 * Summarize metrics + traces into the one paragraph the investigator cites:
 * "91% of failed traces enter payment-service; p99 2.1s; error rate 18%".
 * Pure arithmetic over provider data — no LLM, no invented percentages.
 */
export function summarizeCrossSignal(opts: {
  service: string;
  from: number;
  to: number;
  errorRate?: MetricSeries;
  p99?: MetricSeries;
  failed: TraceSample[];
}): CrossSignalSummary {
  const dependencyEntryShare: Record<string, number> = {};
  if (opts.failed.length > 0) {
    const counts = new Map<string, number>();
    for (const trace of opts.failed) {
      const entry = trace.spans.find((s) => s.service !== opts.service && s.status === 'error')
        ?? trace.spans.find((s) => s.service !== opts.service);
      if (entry) counts.set(entry.service, (counts.get(entry.service) ?? 0) + 1);
    }
    for (const [svc, n] of counts) dependencyEntryShare[svc] = n / opts.failed.length;
  }
  const top = Object.entries(dependencyEntryShare).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
  const errorRate = lastValue(opts.errorRate);
  const p99LatencyMs = lastValue(opts.p99);
  const parts: string[] = [];
  if (errorRate !== undefined) parts.push(`error rate ${(errorRate * 100).toFixed(1)}%`);
  if (p99LatencyMs !== undefined) parts.push(`p99 ${Math.round(p99LatencyMs)}ms`);
  parts.push(`${opts.failed.length} failed trace(s) sampled`);
  if (top) parts.push(`${Math.round((top[1] ?? 0) * 100)}% enter ${top[0]}`);
  return {
    service: opts.service,
    window: { from: opts.from, to: opts.to },
    ...(errorRate !== undefined ? { errorRate } : {}),
    ...(p99LatencyMs !== undefined ? { p99LatencyMs } : {}),
    failedTraceCount: opts.failed.length,
    dependencyEntryShare,
    waterfallNote: parts.join('; '),
  };
}

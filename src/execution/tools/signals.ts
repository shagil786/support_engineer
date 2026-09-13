/**
 * query_signals executor — read-only metrics/traces summary for the investigator.
 * Unwired providers → honest "not configured". Partial data (metrics without
 * traces) still summarizes — the waterfall note says what was sampled.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import { summarizeCrossSignal } from '../../signals/types.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['query_signals']['schema']>;

export async function querySignals(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.metricsProvider && !ctx.traceProvider) {
    return { ok: false, error: 'query_signals unavailable — metrics/trace providers not configured' };
  }
  try {
    const [errorRate, p99, failed] = await Promise.all([
      ctx.metricsProvider?.query(args.service, 'error_rate', args.from, args.to).catch(() => undefined),
      ctx.metricsProvider?.query(args.service, 'p99_latency_ms', args.from, args.to).catch(() => undefined),
      ctx.traceProvider?.failedTraces(args.service, args.from, args.to, 20).catch(() => []) ?? Promise.resolve([]),
    ]);
    const summary = summarizeCrossSignal({
      service: args.service,
      from: args.from,
      to: args.to,
      ...(errorRate ? { errorRate } : {}),
      ...(p99 ? { p99 } : {}),
      failed,
    });
    return { ok: true, data: summary };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { ok: false, error: 'Signal query failed', detail: String(e) };
  }
}

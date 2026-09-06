/**
 * query_logs executor. Time-range mapping preserved from handlers.ts.
 * Tool-side failures return ToolResult; transport failures THROW so the
 * ToolRunner can retry them.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['query_logs']['schema']>;

/** Mirror of tools/handlers.ts time ranges for the schema-constrained enum. */
const RANGE_MS: Record<NonNullable<Args['time_range']>, number> = {
  last_15m: 15 * 60_000,
  last_30m: 30 * 60_000,
  last_1h: 60 * 60_000,
  last_24h: 24 * 60 * 60_000,
};

export async function queryLogs(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.logProvider) {
    return { ok: false, error: 'query_logs unavailable — integration not configured' };
  }
  const range = args.time_range ?? 'last_30m';
  const to = Date.now();
  const from = to - RANGE_MS[range];
  try {
    const result = await ctx.logProvider.query({ query: args.query_string, from, to, limit: 50 });
    if (result.error) {
      // Provider-level handled failure (query syntax, permissions): not
      // retryable — the same query will fail the same way.
      return { ok: false, error: 'Log query failed', detail: result.error };
    }
    return { ok: true, data: { provider: result.provider, rows: result.rows, time_range: range } };
  } catch (e) {
    if (e instanceof Error) throw e; // transport — retryable by ToolRunner
    return { ok: false, error: 'Log query failed', detail: String(e) };
  }
}

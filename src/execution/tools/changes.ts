/**
 * correlate_changes executor — read-only GitHub/change-intel lookup.
 * Unwired provider → honest "not configured", never invented PRs.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import { correlateChanges } from '../../change/types.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['correlate_changes']['schema']>;

export async function correlateChangesTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.changeProvider) {
    return { ok: false, error: 'correlate_changes unavailable — change provider not configured' };
  }
  const lookbackMs = args.lookback_ms ?? 60 * 60_000;
  try {
    const changes = await ctx.changeProvider.recentChanges(args.service, { since: args.incident_ts - lookbackMs, limit: 50 });
    const suspects = correlateChanges(changes, {
      incidentTs: args.incident_ts,
      lookbackMs,
      ...(args.signals ? { signals: args.signals } : {}),
    });
    return { ok: true, data: { service: args.service, suspects: suspects.slice(0, 5) } };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { ok: false, error: 'Change correlation failed', detail: String(e) };
  }
}

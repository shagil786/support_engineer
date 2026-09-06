/**
 * invoke_human_on_slack executor. Message shaping preserved from handlers.ts.
 * Tool-side failures return ToolResult; transport failures THROW so the
 * ToolRunner can retry them.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['invoke_human_on_slack']['schema']>;

export async function invokeHumanOnSlack(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.slackNotifier) {
    return { ok: false, error: 'invoke_human_on_slack unavailable — integration not configured' };
  }
  const platform = args.platform ?? 'slack';
  try {
    await ctx.slackNotifier.postMessage(args.target_user, `[@${args.target_user}] ${args.message} (via ${platform})`);
    return { ok: true, data: { target_user: args.target_user, platform, delivered: true } };
  } catch (e) {
    if (e instanceof Error) throw e; // transport — retryable by ToolRunner
    return { ok: false, error: 'Slack notification failed', detail: String(e) };
  }
}

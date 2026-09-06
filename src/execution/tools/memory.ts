/**
 * meeting_interrupt executor — speaks through the deterministic etiquette
 * brain (which enforces mode, pause gating, and the word cap). P0/P1 wording
 * preserved from handlers.ts.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['meeting_interrupt']['schema']>;

export async function meetingInterrupt(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.speak) {
    return { ok: false, error: 'meeting_interrupt unavailable — no speak function wired' };
  }
  const urgency = args.urgency ?? 'critical';
  ctx.speak(urgency === 'critical' ? `Excuse me, urgent alert: ${args.message}` : args.message);
  return { ok: true, data: { spoken: true, urgency } };
}

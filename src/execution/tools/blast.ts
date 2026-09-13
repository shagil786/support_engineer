/**
 * assess_blast_radius executor — read-only topology assessment.
 * Unwired topology → honest "not configured". Never invents dependencies.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['assess_blast_radius']['schema']>;

export async function assessBlast(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.topology) {
    return { ok: false, error: 'assess_blast_radius unavailable — topology not configured' };
  }
  return { ok: true, data: ctx.topology.assess(args.service, args.action) };
}

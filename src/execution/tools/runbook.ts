/**
 * execute_runbook_script executor. Destructive-action gating stays in the
 * Governance layer; this executor runs what the gate approved. Tool-side
 * failures return ToolResult; transport failures THROW so the ToolRunner
 * can retry them.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['execute_runbook_script']['schema']>;

export async function executeRunbook(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.runbookProvider) {
    return { ok: false, error: 'execute_runbook_script unavailable — integration not configured' };
  }
  try {
    const result = await ctx.runbookProvider.run(args.script_name);
    if (!result.ok) {
      return { ok: false, error: 'Runbook action failed', detail: result.error ?? result.output };
    }
    return {
      ok: true,
      data: { action_id: result.actionId, output: result.output, environment: args.environment ?? 'staging' },
    };
  } catch (e) {
    if (e instanceof Error) throw e; // transport — retryable by ToolRunner
    return { ok: false, error: 'Runbook execution failed', detail: String(e) };
  }
}

/**
 * verify_remediation executor — post-action success-criteria evaluation.
 * Reads metrics (and an optional synthetic) AFTER the action settled, then
 * reports confirmed vs rollback/escalate. Fail-closed: unreadable metrics
 * are FAILED readings, never "confirmed".
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import { verifyRemediation } from '../../remediation/verifier.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['verify_remediation']['schema']>;

export async function verifyRemediationTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const verdict = await verifyRemediation(
    {
      service: args.service,
      settleMs: 0,
      criteria: args.criteria.map((c) => ({ metric: c.metric, op: c.op, threshold: c.threshold, label: c.label })),
      ...(args.synthetic ? { synthetic: { name: args.synthetic } } : {}),
      onFailure: args.on_failure ?? 'escalate',
      ...(args.rollback_runbook_id ? { rollbackRunbookId: args.rollback_runbook_id } : {}),
    },
    {
      ...(ctx.metricsProvider ? { metrics: ctx.metricsProvider } : {}),
      ...(ctx.syntheticCheck ? { synthetic: ctx.syntheticCheck } : {}),
      sleep: async () => {},
    },
  );
  if (verdict.passed) return { ok: true, data: verdict };
  return { ok: false, error: `remediation not verified → ${verdict.next}`, detail: verdict };
}

/**
 * InvestigatorAgent — plans READ-ONLY investigation steps. The Supervisor
 * executes the plan through the ToolRunner and feeds results to the
 * ReviewerAgent; the agent itself never runs anything.
 */
import { z } from 'zod';
import { LlmAgent, type AgentRunInput } from './base.js';

const Schema = z.object({
  plan: z.array(
    z.object({
      tool: z.enum(['query_logs', 'invoke_human_on_slack']),
      args: z.record(z.string(), z.unknown()),
    }),
  ).default([]),
});

export type InvestigatorDecision = z.output<typeof Schema>;

export class InvestigatorAgent extends LlmAgent<typeof Schema> {
  protected schema = Schema;
  /** The prompt must carry each tool's EXACT arg schema: the ToolRunner
   *  Zod-validates every planned call, and models invent plausible arg names
   *  ("query", "search", "log_level") that fail validation — the step dies
   *  with 'invalid args' before the real work starts (found live: every
   *  investigation failed this way under a reasoning model). */
  protected systemPrompt =
    'You are the InvestigatorAgent. Plan read-only investigation steps to answer the question. ' +
    'Output ONLY JSON: { "plan": [{ "tool": "query_logs"|"invoke_human_on_slack", "args": object }] }.\n' +
    'Tool arg schemas (exact field names, required unless marked optional):\n' +
    '- query_logs: { query_string: string (required), time_range: "last_15m"|"last_30m"|"last_1h"|"last_24h" (optional) }\n' +
    '- invoke_human_on_slack: { target_user: string (required), message: string (required), platform: "slack"|"teams"|"email" (optional) }\n' +
    'Example: {"plan":[{"tool":"query_logs","args":{"query_string":"error checkout","time_range":"last_1h"}}]}';

  protected fallback(_input: AgentRunInput): InvestigatorDecision {
    return { plan: [] };
  }
}

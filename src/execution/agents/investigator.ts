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
  protected systemPrompt =
    'You are the InvestigatorAgent. Plan read-only investigation steps to answer the question. ' +
    'Output ONLY JSON: { "plan": [{ "tool": "query_logs"|"invoke_human_on_slack", "args": object }] }.';

  protected fallback(_input: AgentRunInput): InvestigatorDecision {
    return { plan: [] };
  }
}

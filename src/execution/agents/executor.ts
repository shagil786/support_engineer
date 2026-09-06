/**
 * ExecutorAgent — plans SIDE-EFFECT steps (tickets, runbooks, pings). Every
 * step still passes through Governance + the ToolRunner; the agent only
 * proposes. Fallback proposes nothing — side effects are never invented
 * without an LLM or an explicit envelope signal.
 */
import { z } from 'zod';
import { LlmAgent, type AgentRunInput } from './base.js';

const Schema = z.object({
  sideEffects: z.array(
    z.object({
      tool: z.enum(['jira_create_issue', 'execute_runbook_script', 'invoke_human_on_slack', 'meeting_interrupt']),
      args: z.record(z.string(), z.unknown()),
    }),
  ).default([]),
});

export type ExecutorDecision = z.output<typeof Schema>;

export class ExecutorAgent extends LlmAgent<typeof Schema> {
  protected schema = Schema;
  protected systemPrompt =
    'You are the ExecutorAgent. Plan the minimal side-effect steps that resolve the request. ' +
    'Output ONLY JSON: { "sideEffects": [{ "tool": string, "args": object }] }. ' +
    'Tools: jira_create_issue, execute_runbook_script, invoke_human_on_slack, meeting_interrupt.';

  protected fallback(_input: AgentRunInput): ExecutorDecision {
    return { sideEffects: [] };
  }
}

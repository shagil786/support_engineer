/**
 * TriageAgent — classifies the envelope for the execution pipeline and
 * suggests the next tool. Fallback mirrors the Understanding layer's
 * classification so no-LLM behavior remains deterministic and sane.
 * Tool suggestions bind to the real ToolName union.
 */
import { z } from 'zod';
import { LlmAgent, type AgentRunInput } from './base.js';

const ToolEnum = z.enum([
  'jira_create_issue', 'query_logs', 'execute_runbook_script',
  'invoke_human_on_slack', 'meeting_interrupt',
]);

const Schema = z.object({
  subKind: z.string(),
  severity: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']).optional(),
  suggestedTools: z.array(ToolEnum).default([]),
});

export type TriageDecision = z.output<typeof Schema>;

export class TriageAgent extends LlmAgent<typeof Schema> {
  protected schema = Schema;
  protected systemPrompt =
    'You are the TriageAgent of a support voice agent. Classify the intent envelope and propose the next investigation tool (or none). ' +
    'Output ONLY JSON: { "subKind": string, "severity"?: "P0"|"P1"|"P2"|"P3"|"P4", "suggestedTools": string[] }. ' +
    `Tool names must be exactly one of: ${ToolEnum.options.join(', ')}.`;

  protected fallback(input: AgentRunInput): TriageDecision {
    const env = input.envelope;
    const tools: TriageDecision['suggestedTools'] = [];
    if (env.entities.ticketKeys?.length) tools.push('query_logs');
    if (env.intent.kind === 'meeting_response' && env.intent.subKind === 'runbook_offer') {
      tools.push('execute_runbook_script');
    }
    if (env.intent.kind === 'proactive_alert') tools.push('meeting_interrupt');
    const subKind = 'subKind' in env.intent ? env.intent.subKind : 'unknown';
    return { subKind, severity: env.entities.severity, suggestedTools: tools };
  }
}

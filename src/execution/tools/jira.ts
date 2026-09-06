/**
 * jira_create_issue executor. Behavior and error wrapping preserved from
 * tools/handlers.ts so legacy and governed paths behave identically.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import { jiraPriorityName } from '../../support-voice-agent/integrations/jira.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['jira_create_issue']['schema']>;

export async function jiraCreateIssue(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.jiraClient) {
    return { ok: false, error: 'jira_create_issue unavailable — integration not configured' };
  }
  try {
    const issue = await ctx.jiraClient.createIssue({
      projectKey: args.project_key,
      summary: args.summary,
      issueType: args.issue_type,
      priority: args.priority ? jiraPriorityName(args.priority) : undefined,
      description: args.description,
    });
    return { ok: true, data: { ticket_id: issue.key, url: issue.self } };
  } catch (e) {
    return { ok: false, error: 'Jira createIssue failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

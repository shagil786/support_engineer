/**
 * jira_create_issue executor. Tool-side failures (validation, not-wired)
 * return ToolResult; transport failures THROW so the ToolRunner can retry
 * them. Success/error shaping preserved from tools/handlers.ts.
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
    if (e instanceof Error) throw e; // transport — retryable by ToolRunner
    return { ok: false, error: 'Jira createIssue failed', detail: String(e) };
  }
}

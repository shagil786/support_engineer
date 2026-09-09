/**
 * jira_get_issue executor — the read-only ticket-status path. Tool-side
 * failures return ToolResult; transport failures THROW so the ToolRunner
 * can retry them (same contract as jiraCreateIssue).
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['jira_get_issue']['schema']>;

export async function jiraGetIssue(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.jiraGetIssueClient) {
    return { ok: false, error: 'jira_get_issue unavailable — integration not configured' };
  }
  try {
    const issue = await ctx.jiraGetIssueClient.getIssue(args.issue_key);
    return { ok: true, data: issue };
  } catch (e) {
    if (e instanceof Error) throw e; // transport — retryable by ToolRunner
    return { ok: false, error: 'Jira getIssue failed', detail: String(e) };
  }
}

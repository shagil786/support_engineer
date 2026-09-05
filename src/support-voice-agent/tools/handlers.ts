/** Tool handlers — thin delegation to the real injected integration ports. */
import { jiraPriorityName } from '../integrations/jira.js';
import type { LogQuery } from '../types.js';
import type { ToolResult, ToolDependencies, ToolName } from './types.js';

function unwired(name: ToolName): ToolResult {
  return { ok: false, error: `${name} unavailable — integration not configured` };
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Accepts "last_30m", "last_15m", "last_1h", "last_24h"; falls back to 30m. */
export function parseTimeRange(range: string | undefined, now: number): { from: number; to: number } {
  const minutes = range === 'last_15m' ? 15 : range === 'last_1h' ? 60 : range === 'last_24h' ? 24 * 60 : 30;
  return { from: now - minutes * 60_000, to: now };
}

export const handlers: Record<ToolName, (args: unknown, deps: ToolDependencies) => Promise<ToolResult>> = {
  async jira_create_issue(args, deps) {
    if (!deps.jiraClient) return unwired('jira_create_issue');
    const a = (args ?? {}) as Record<string, unknown>;
    const summary = str(a, 'summary');
    const issueType = str(a, 'issue_type');
    if (!summary || !issueType) {
      return { ok: false, error: 'jira_create_issue requires summary and issue_type' };
    }
    const priority = str(a, 'priority');
    try {
      const issue = await deps.jiraClient.createIssue({
        summary,
        issueType,
        projectKey: str(a, 'project_key'),
        priority: priority ? jiraPriorityName(priority) : undefined,
        description: str(a, 'description'),
      });
      return { ok: true, data: { ticket_id: issue.key, url: issue.self } };
    } catch (e) {
      return { ok: false, error: 'Jira createIssue failed', detail: err(e) };
    }
  },

  async query_logs(args, deps) {
    if (!deps.logProvider) return unwired('query_logs');
    const a = (args ?? {}) as Record<string, unknown>;
    const queryString = str(a, 'query_string');
    if (!queryString) return { ok: false, error: 'query_logs requires query_string' };
    const { from, to } = parseTimeRange(str(a, 'time_range'), Date.now());
    const query: LogQuery = { query: queryString, from, to, limit: 50 };
    try {
      const result = await deps.logProvider.query(query);
      if (result.error) return { ok: false, error: 'Log query failed', detail: result.error };
      return { ok: true, data: { provider: result.provider, rows: result.rows, time_range: str(a, 'time_range') ?? 'last_30m' } };
    } catch (e) {
      return { ok: false, error: 'Log query failed', detail: err(e) };
    }
  },

  async execute_runbook_script(args, deps) {
    if (!deps.runbookProvider) return unwired('execute_runbook_script');
    const a = (args ?? {}) as Record<string, unknown>;
    const scriptName = str(a, 'script_name');
    if (!scriptName) return { ok: false, error: 'execute_runbook_script requires script_name' };
    try {
      const result = await deps.runbookProvider.run(scriptName);
      if (!result.ok) return { ok: false, error: 'Runbook action failed', detail: result.error ?? result.output };
      return { ok: true, data: { action_id: result.actionId, output: result.output, environment: str(a, 'environment') ?? 'staging' } };
    } catch (e) {
      return { ok: false, error: 'Runbook execution failed', detail: err(e) };
    }
  },

  async invoke_human_on_slack(args, deps) {
    if (!deps.slackNotifier) return unwired('invoke_human_on_slack');
    const a = (args ?? {}) as Record<string, unknown>;
    const targetUser = str(a, 'target_user');
    const message = str(a, 'message');
    if (!targetUser || !message) return { ok: false, error: 'invoke_human_on_slack requires target_user and message' };
    const platform = str(a, 'platform') ?? 'slack';
    try {
      await deps.slackNotifier.postMessage(targetUser, `[@${targetUser}] ${message} (via ${platform})`);
      return { ok: true, data: { target_user: targetUser, platform, delivered: true } };
    } catch (e) {
      return { ok: false, error: 'Slack notification failed', detail: err(e) };
    }
  },

  async meeting_interrupt(args, deps) {
    if (!deps.speak) return unwired('meeting_interrupt');
    const a = (args ?? {}) as Record<string, unknown>;
    const message = str(a, 'message');
    if (!message) return { ok: false, error: 'meeting_interrupt requires message' };
    const urgency = str(a, 'urgency') ?? 'critical';
    const prefix = urgency === 'critical' ? 'Excuse me, urgent alert: ' : '';
    try {
      deps.speak(`${prefix}${message}`);
      return { ok: true, data: { urgency, spoken: true } };
    } catch (e) {
      return { ok: false, error: 'Interrupt emit failed', detail: err(e) };
    }
  },
};

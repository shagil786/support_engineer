/**
 * Per-tool Zod schemas, isolated in their own module so tool executors and
 * the registry can both import them without a circular type dependency.
 *
 * Ported from TOOL_SCHEMAS (JSON Schema → Zod), preserving the legacy enums.
 * `project_key` is optional: JiraClient falls back to its configured default
 * project (existing tested behavior).
 */
import { z } from 'zod';

export const JiraCreateIssueSchema = z.object({
  project_key: z.string().min(1).optional(),
  summary: z.string().min(1),
  issue_type: z.enum(['Bug', 'Task', 'Story']),
  priority: z.enum(['Highest', 'High', 'Medium', 'Low', 'Lowest']).optional(),
  description: z.string().optional(),
});

export const QueryLogsSchema = z.object({
  query_string: z.string().min(1),
  time_range: z.enum(['last_15m', 'last_30m', 'last_1h', 'last_24h']).optional(),
});

export const ExecuteRunbookSchema = z.object({
  script_name: z.string().min(1),
  environment: z.enum(['staging', 'prod']).optional(),
});

export const InvokeHumanOnSlackSchema = z.object({
  target_user: z.string().min(1),
  message: z.string().min(1),
  platform: z.enum(['slack', 'teams', 'email']).optional(),
});

export const MeetingInterruptSchema = z.object({
  message: z.string().min(1),
  urgency: z.enum(['normal', 'critical']).optional(),
});

export type JiraCreateIssueArgs = z.output<typeof JiraCreateIssueSchema>;
export type QueryLogsArgs = z.output<typeof QueryLogsSchema>;
export type ExecuteRunbookArgs = z.output<typeof ExecuteRunbookSchema>;
export type InvokeHumanOnSlackArgs = z.output<typeof InvokeHumanOnSlackSchema>;
export type MeetingInterruptArgs = z.output<typeof MeetingInterruptSchema>;

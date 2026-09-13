/**
 * Per-tool Zod schemas, isolated in their own module so tool executors and
 * the registry can both import them without a circular type dependency.
 *
 * Ported from TOOL_SCHEMAS (JSON Schema → Zod), preserving the legacy enums.
 * `project_key` is optional: JiraClient falls back to its configured default
 * project (existing tested behavior).
 */
import { z } from 'zod';

export const JiraGetIssueSchema = z.object({
  issue_key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, 'issue_key must be a Jira key like SUPPORT-7'),
});

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

/** Read-only evidence-graph query: which nodes/edges surround a service. */
export const QueryEvidenceSchema = z.object({
  service: z.string().min(1),
  kinds: z.array(z.enum(['service', 'dependency', 'log', 'trace', 'metric', 'deployment', 'pr', 'jira', 'incident', 'runbook'])).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

/** Read-only change correlation: recent GitHub deploys/PRs/flags for a service. */
export const CorrelateChangesSchema = z.object({
  service: z.string().min(1),
  incident_ts: z.number().int().positive(),
  lookback_ms: z.number().int().positive().max(7 * 24 * 60 * 60_000).optional(),
  signals: z.array(z.string()).max(20).optional(),
});

/** Read-only metrics/traces summary for a service window. */
export const QuerySignalsSchema = z.object({
  service: z.string().min(1),
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
});

/** Post-action remediation verification (read-only metric reads + synthetic). */
export const VerifyRemediationSchema = z.object({
  service: z.string().min(1),
  criteria: z.array(z.object({
    metric: z.string().min(1),
    op: z.enum(['lt', 'lte', 'gt', 'gte']),
    threshold: z.number(),
    label: z.string().min(1),
  })).min(1).max(10),
  synthetic: z.string().min(1).optional(),
  on_failure: z.enum(['rollback', 'escalate']).optional(),
  rollback_runbook_id: z.string().min(1).optional(),
});

/** Pre-execution blast-radius assessment (read-only topology read). */
export const AssessBlastSchema = z.object({
  service: z.string().min(1),
  action: z.enum(['restart', 'rollback', 'scale', 'failover']),
});

export type JiraGetIssueArgs = z.output<typeof JiraGetIssueSchema>;
export type JiraCreateIssueArgs = z.output<typeof JiraCreateIssueSchema>;
export type QueryLogsArgs = z.output<typeof QueryLogsSchema>;
export type ExecuteRunbookArgs = z.output<typeof ExecuteRunbookSchema>;
export type InvokeHumanOnSlackArgs = z.output<typeof InvokeHumanOnSlackSchema>;
export type MeetingInterruptArgs = z.output<typeof MeetingInterruptSchema>;
export type QueryEvidenceArgs = z.output<typeof QueryEvidenceSchema>;
export type CorrelateChangesArgs = z.output<typeof CorrelateChangesSchema>;
export type QuerySignalsArgs = z.output<typeof QuerySignalsSchema>;
export type VerifyRemediationArgs = z.output<typeof VerifyRemediationSchema>;
export type AssessBlastArgs = z.output<typeof AssessBlastSchema>;

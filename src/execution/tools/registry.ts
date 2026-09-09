/**
 * Tool registry for the Execution layer (spec §6.1). Each entry pairs a Zod
 * schema with its executor; ToolRunner is the ONLY caller of `execute`.
 */
import type { z } from 'zod';
import type { ToolName, ToolResult } from '../../support-voice-agent/tools/types.js';
import {
  JiraGetIssueSchema,
  JiraCreateIssueSchema,
  QueryLogsSchema,
  ExecuteRunbookSchema,
  InvokeHumanOnSlackSchema,
  MeetingInterruptSchema,
  type JiraGetIssueArgs,
  type JiraCreateIssueArgs,
  type QueryLogsArgs,
  type ExecuteRunbookArgs,
  type InvokeHumanOnSlackArgs,
  type MeetingInterruptArgs,
} from './schemas.js';
import { jiraGetIssue } from './jira-get.js';
import { jiraCreateIssue } from './jira.js';
import { queryLogs } from './logs.js';
import { executeRunbook } from './runbook.js';
import { invokeHumanOnSlack } from './slack.js';
import { meetingInterrupt } from './memory.js';

/** Integration ports injected into tool executors. Mirrors the real client
 *  interfaces so the Supervisor can wire actual instances directly. */
export interface ToolContext {
  jiraClient?: Pick<import('../../support-voice-agent/integrations/jira.js').JiraClient, 'createIssue'>;
  /** Read-only Jira port; split so a viewer-scoped token cannot create. */
  jiraGetIssueClient?: Pick<import('../../support-voice-agent/integrations/jira.js').JiraClient, 'getIssue'>;
  logProvider?: import('../../support-voice-agent/types.js').LogProvider;
  runbookProvider?: import('../../support-voice-agent/integrations/runbook.js').RunbookProvider;
  slackNotifier?: import('../../support-voice-agent/integrations/slack.js').SlackNotifier;
  /** Emits a spoken line through the etiquette brain. */
  speak?: (text: string) => void;
  /** The speaker whose utterance triggered this tool round. */
  currentSpeaker?: () => string | undefined;
}

export interface ToolEntry<TSchema extends z.ZodType = z.ZodType> {
  schema: TSchema;
  execute(args: z.output<TSchema>, ctx: ToolContext): Promise<ToolResult>;
}

export const TOOL_REGISTRY = {
  jira_get_issue: {
    schema: JiraGetIssueSchema,
    execute: (args: JiraGetIssueArgs, ctx: ToolContext): Promise<ToolResult> => jiraGetIssue(args, ctx),
  },
  jira_create_issue: {
    schema: JiraCreateIssueSchema,
    execute: (args: JiraCreateIssueArgs, ctx: ToolContext): Promise<ToolResult> => jiraCreateIssue(args, ctx),
  },
  query_logs: {
    schema: QueryLogsSchema,
    execute: (args: QueryLogsArgs, ctx: ToolContext): Promise<ToolResult> => queryLogs(args, ctx),
  },
  execute_runbook_script: {
    schema: ExecuteRunbookSchema,
    execute: (args: ExecuteRunbookArgs, ctx: ToolContext): Promise<ToolResult> => executeRunbook(args, ctx),
  },
  invoke_human_on_slack: {
    schema: InvokeHumanOnSlackSchema,
    execute: (args: InvokeHumanOnSlackArgs, ctx: ToolContext): Promise<ToolResult> => invokeHumanOnSlack(args, ctx),
  },
  meeting_interrupt: {
    schema: MeetingInterruptSchema,
    execute: (args: MeetingInterruptArgs, ctx: ToolContext): Promise<ToolResult> => meetingInterrupt(args, ctx),
  },
} as const satisfies Record<ToolName, ToolEntry>;

export type ToolEntryOf<T extends ToolName> = (typeof TOOL_REGISTRY)[T];

export function toolNames(): ToolName[] {
  return Object.keys(TOOL_REGISTRY) as ToolName[];
}

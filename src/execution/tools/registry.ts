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
  QueryEvidenceSchema,
  CorrelateChangesSchema,
  QuerySignalsSchema,
  VerifyRemediationSchema,
  AssessBlastSchema,
  type JiraGetIssueArgs,
  type JiraCreateIssueArgs,
  type QueryLogsArgs,
  type ExecuteRunbookArgs,
  type InvokeHumanOnSlackArgs,
  type MeetingInterruptArgs,
  type QueryEvidenceArgs,
  type CorrelateChangesArgs,
  type QuerySignalsArgs,
  type VerifyRemediationArgs,
  type AssessBlastArgs,
} from './schemas.js';
import { jiraGetIssue } from './jira-get.js';
import { jiraCreateIssue } from './jira.js';
import { queryLogs } from './logs.js';
import { executeRunbook } from './runbook.js';
import { invokeHumanOnSlack } from './slack.js';
import { meetingInterrupt } from './memory.js';
import { queryEvidence } from './evidence.js';
import { correlateChangesTool } from './changes.js';
import { querySignals } from './signals.js';
import { verifyRemediationTool } from './verify-remediation.js';
import { assessBlast } from './blast.js';

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
  /** Live incident evidence graph (read-only queries). Unwired → query_evidence degrades honestly. */
  evidenceGraph?: import('../../evidence/graph.js').EvidenceGraph;
  /** GitHub/CI-CD change feed (read-only). Unwired → correlate_changes degrades honestly. */
  changeProvider?: import('../../change/types.js').ChangeProvider;
  /** Metrics backend (Prometheus/Grafana/Datadog/New Relic adapters satisfy this). */
  metricsProvider?: import('../../signals/types.js').MetricsProvider;
  /** Distributed-trace backend (OpenTelemetry adapters satisfy this). */
  traceProvider?: import('../../signals/types.js').TraceProvider;
  /** Service dependency graph for blast-radius assessment. */
  topology?: import('../../topology/blast.js').ServiceTopology;
  /** Named synthetic check runner (e.g. synthetic checkout). */
  syntheticCheck?: (name: string) => Promise<boolean>;
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
  query_evidence: {
    schema: QueryEvidenceSchema,
    execute: (args: QueryEvidenceArgs, ctx: ToolContext): Promise<ToolResult> => queryEvidence(args, ctx),
  },
  correlate_changes: {
    schema: CorrelateChangesSchema,
    execute: (args: CorrelateChangesArgs, ctx: ToolContext): Promise<ToolResult> => correlateChangesTool(args, ctx),
  },
  query_signals: {
    schema: QuerySignalsSchema,
    execute: (args: QuerySignalsArgs, ctx: ToolContext): Promise<ToolResult> => querySignals(args, ctx),
  },
  verify_remediation: {
    schema: VerifyRemediationSchema,
    execute: (args: VerifyRemediationArgs, ctx: ToolContext): Promise<ToolResult> => verifyRemediationTool(args, ctx),
  },
  assess_blast_radius: {
    schema: AssessBlastSchema,
    execute: (args: AssessBlastArgs, ctx: ToolContext): Promise<ToolResult> => assessBlast(args, ctx),
  },
} as const satisfies Record<ToolName, ToolEntry>;

export type ToolEntryOf<T extends ToolName> = (typeof TOOL_REGISTRY)[T];

export function toolNames(): ToolName[] {
  return Object.keys(TOOL_REGISTRY) as ToolName[];
}

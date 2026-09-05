/** JSON function schemas for the agent's callable tools (Layer 2). */

export const TOOL_SCHEMAS = {
  jira_create_issue: {
    name: 'jira_create_issue',
    description: 'Create a Jira ticket from spoken feedback.',
    parameters: {
      type: 'object',
      properties: {
        project_key: { type: 'string' },
        summary: { type: 'string' },
        issue_type: { type: 'string', enum: ['Bug', 'Task', 'Story'] },
        priority: { type: 'string', enum: ['Highest', 'High', 'Medium'] },
        description: { type: 'string' },
      },
      required: ['project_key', 'summary', 'issue_type'],
    },
  },
  query_logs: {
    name: 'query_logs',
    description: 'Query Splunk/CloudWatch for error stacks.',
    parameters: {
      type: 'object',
      properties: {
        query_string: { type: 'string' },
        time_range: { type: 'string', default: 'last_30m' },
      },
      required: ['query_string'],
    },
  },
  execute_runbook_script: {
    name: 'execute_runbook_script',
    description: 'Execute a safe, pre-approved automation (e.g., restart pod, clear cache). Requires human approval for destructive actions.',
    parameters: {
      type: 'object',
      properties: {
        script_name: { type: 'string' },
        environment: { type: 'string', enum: ['staging', 'prod'] },
        requires_approval: { type: 'boolean' },
      },
      required: ['script_name'],
    },
  },
  invoke_human_on_slack: {
    name: 'invoke_human_on_slack',
    description: 'Send a direct message or mention a specific human on Slack/Teams to verify something or get a decision.',
    parameters: {
      type: 'object',
      properties: {
        target_user: { type: 'string' },
        message: { type: 'string' },
        platform: { type: 'string', enum: ['slack', 'teams', 'email'] },
      },
      required: ['target_user', 'message'],
    },
  },
  meeting_interrupt: {
    name: 'meeting_interrupt',
    description: 'Politely barge in to deliver a P1 alert or critical information.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        urgency: { type: 'string', enum: ['normal', 'critical'] },
      },
      required: ['message'],
    },
  },
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export type ToolSchema = typeof TOOL_SCHEMAS[ToolName];
export type ToolParameters<T extends ToolName> = ToolSchema['parameters'] extends { properties: infer P } ? P : never;
export type ToolCall = { name: ToolName; arguments: Record<string, unknown> | string; id: string };

/** Result of a tool execution — always a value, never a thrown error. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; detail?: unknown };

/** Handler for a tool — receives parsed args + injected dependencies, returns ToolResult. */
export type ToolHandler = (args: unknown, deps: ToolDependencies) => Promise<ToolResult>;

/** Dependencies injected into tool handlers. These mirror the real
 *  integration ports so the orchestrator can wire the actual clients. */
export interface ToolDependencies {
  jiraClient?: Pick<import('../integrations/jira.js').JiraClient, 'createIssue'>;
  logProvider?: import('../types.js').LogProvider;
  runbookProvider?: import('../integrations/runbook.js').RunbookProvider;
  slackNotifier?: import('../integrations/slack.js').SlackNotifier;
  /** Emits a spoken line through the deterministic etiquette brain
   *  (which enforces mode, pause gating, and the word cap). */
  speak?: (text: string) => void;
  /** Layer 4 guardrails — hard approval gate for destructive actions. */
  guardrails?: import('../guardrails.js').Guardrails;
  /** The speaker whose last utterance triggered this tool round. */
  currentSpeaker?: () => string | undefined;
}

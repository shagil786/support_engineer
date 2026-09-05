export { SupportVoiceAgent } from './support-voice-agent/agent';
export type { SupportVoiceAgentConfig } from './support-voice-agent/agent';
export {
  DEFAULT_SETTINGS,
  createAgent,
  configFromEnv,
  jiraConfigFromEnv,
  requireJira,
  llmConfigFromEnv,
  createLlmClient,
} from './config';
export type { IntegrationsFromEnv, Settings } from './config';
export { DEFAULT_WAKE_WORD, DEFAULT_MIN_PAUSE_MS, DEFAULT_MAX_RESPONSE_WORDS, DEFAULT_MUTE_DURATION_MS, DEFAULT_RUNBOOK_CONFIRM_WINDOW_MS } from './support-voice-agent/heuristics';
export { SAMPLE_RUNBOOK_ACTIONS } from './fixtures/sample-runbooks';
export { TypedEmitter } from './support-voice-agent/events';
export type {
  AgentMode,
  Utterance,
  AlertSignal,
  FeedbackItem,
  ConcernItem,
  JiraChange,
  MeetingSummaryData,
  Severity,
  SpeechEvent,
  LogQuery,
  LogRow,
  LogQueryResult,
  LogProvider,
} from './support-voice-agent/types';
export type {
  CreateIssueOptions,
  CreatedIssue,
  IssueInfo,
  JiraAuth,
} from './support-voice-agent/integrations/jira';
export type {
  RunbookAction,
  RunbookProvider,
  RunbookResult,
  RunbookNotFoundError,
} from './support-voice-agent/integrations/runbook';
export type {
  SlackNotifier,
  SlackWebhookConfig,
} from './support-voice-agent/integrations/slack';
export type {
  AwsSigner,
  CloudWatchCell,
  CloudWatchConfig,
  SplunkConfig,
} from './support-voice-agent/integrations/logs';
export { renderMeetingSummary } from './support-voice-agent/summary';
export { Guardrails } from './support-voice-agent/guardrails';
export { InMemoryKeyValueStore } from './support-voice-agent/memory/store';
export type { KeyValueStore } from './support-voice-agent/memory/store';
export { InMemoryVectorMemory, hashEmbedder, cosine } from './support-voice-agent/memory/vector';
export type { Embedder, MemoryRecord, SearchHit, VectorMemory } from './support-voice-agent/memory/vector';
export type { SpeakerRole, SpeakerRegistry, GuardrailsConfig, ApprovalDecision } from './support-voice-agent/guardrails';
export {
  JiraClient,
  JiraError,
  formatJiraUpdate,
  formatJiraCreated,
  jiraPriorityName,
} from './support-voice-agent/integrations/jira';
export type {
  JiraConfig,
} from './support-voice-agent/integrations/jira';
export {
  SplunkProvider,
  CloudWatchProvider,
  LogError,
} from './support-voice-agent/integrations/logs';
export { InMemoryRunbookProvider } from './support-voice-agent/integrations/runbook';
export { SlackWebhookNotifier } from './support-voice-agent/integrations/slack';

// Layer 2 — Tool Registry & LLM
export {
  TOOL_SCHEMAS,
  type ToolName,
  type ToolSchema,
  type ToolParameters,
  type ToolCall,
  type ToolResult,
  type ToolHandler,
  type ToolDependencies,
} from './support-voice-agent/tools/types';
export { handlers } from './support-voice-agent/tools/handlers';
export {
  OpenAiCompatibleClient,
  LlmError,
  schemasToOpenAiTools,
  type LlmConfig,
  type LlmMessage,
  type LlmChatRequest,
  type LlmChatResponse,
} from './support-voice-agent/tools/llm';
export {
  LlmOrchestrator,
  DEFAULT_SYSTEM_PROMPT,
  type OrchestratorConfig,
  type OrchestratorResult,
} from './support-voice-agent/tools/orchestrator';

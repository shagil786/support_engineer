/** Application-level settings and environment-driven wiring for Freebuff Desktop.
 *
 * Nothing in this module embeds hosts, tokens, or project keys. Each external
 * integration is wired only when its required environment variables are all
 * present; a missing variable simply leaves that integration unwired (the
 * agent then degrades per spec instead of contacting an invented server).
 * Throwing is reserved for explicit `requireJira()`-style calls.
 *
 * All tunable behavioral defaults come from the exported constants in
 * `support-voice-agent/heuristics.ts` — they are not duplicated here.
 */

import { loadDotEnv } from './env';
import * as h from './support-voice-agent/heuristics';
import { SupportVoiceAgent } from './support-voice-agent/agent';
import type { SupportVoiceAgentConfig } from './support-voice-agent/agent';
import { InMemoryRunbookProvider } from './support-voice-agent/integrations/runbook';
import { SplunkProvider } from './support-voice-agent/integrations/logs';
import { SlackWebhookNotifier } from './support-voice-agent/integrations/slack';
import type { SlackNotifier } from './support-voice-agent/integrations/slack';
import type { JiraConfig } from './support-voice-agent/integrations/jira';
import type { LogProvider } from './support-voice-agent/types';
import { OpenAiCompatibleClient, LlmConfig } from './support-voice-agent/tools/llm';

export interface Settings {
  /** Override the default wake word (e.g. "hey agent" → "buffy"). */
  wakeWord?: string;
  muteDurationMs?: number;
  maxResponseWords?: number;
  autoFileFeedback?: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  wakeWord: h.DEFAULT_WAKE_WORD,
  muteDurationMs: h.DEFAULT_MUTE_DURATION_MS,
  maxResponseWords: h.DEFAULT_MAX_RESPONSE_WORDS,
  autoFileFeedback: false,
};

type Env = Record<string, string | undefined>;

function envVar(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export interface IntegrationsFromEnv {
  jira?: JiraConfig;
  logs?: LogProvider;
  slack?: SlackNotifier;
  llm?: LlmConfig;
}

/** Build a JiraConfig from the environment, or `undefined` when any required
 *  variable is missing (integration stays unwired).
 *
 *  - JIRA_BASE_URL (required)
 *  - JIRA_AUTH_TYPE: 'bearer' (default) | 'basic'
 *  - bearer: JIRA_BEARER_TOKEN; basic: JIRA_EMAIL + JIRA_API_TOKEN
 *  - JIRA_PROJECT_KEY (optional; forwarded to createIssue defaults)
 */
export function jiraConfigFromEnv(env: Env = process.env): JiraConfig | undefined {
  const baseUrl = envVar(env, 'JIRA_BASE_URL');
  if (!baseUrl) return undefined;
  const authType = (envVar(env, 'JIRA_AUTH_TYPE') ?? 'bearer').toLowerCase();
  let auth: JiraConfig['auth'];
  if (authType === 'basic') {
    const email = envVar(env, 'JIRA_EMAIL');
    const apiToken = envVar(env, 'JIRA_API_TOKEN');
    if (!email || !apiToken) return undefined;
    auth = { type: 'basic', email, apiToken };
  } else if (authType === 'bearer') {
    const token = envVar(env, 'JIRA_BEARER_TOKEN');
    if (!token) return undefined;
    auth = { type: 'bearer', token };
  } else {
    return undefined;
  }
  const projectKey = envVar(env, 'JIRA_PROJECT_KEY');
  return { baseUrl, auth, ...(projectKey ? { projectKey } : {}) };
}

/** Strict variant of {@link jiraConfigFromEnv} for call sites that cannot run
 *  without Jira; throws with actionable guidance instead of returning undefined. */
export function requireJira(env: Env = process.env): JiraConfig {
  const jira = jiraConfigFromEnv(env);
  if (!jira) {
    throw new Error(
      'Jira is not configured. Set JIRA_BASE_URL plus JIRA_BEARER_TOKEN ' +
        '(or JIRA_AUTH_TYPE=basic with JIRA_EMAIL and JIRA_API_TOKEN). See .env.example.',
    );
  }
  return jira;
}

/** Build LLM config from environment, or undefined when any required var is missing. */
export function llmConfigFromEnv(env: Env = process.env): LlmConfig | undefined {
  const baseUrl = envVar(env, 'LLM_BASE_URL');
  const apiKey = envVar(env, 'LLM_API_KEY');
  const model = envVar(env, 'LLM_MODEL');
  if (!baseUrl || !apiKey || !model) return undefined;
  return { baseUrl, apiKey, model };
}

/** Return only the integrations whose required environment variables are all
 *  present. Never throws and never embeds credentials or example hosts.
 *
 *  - Jira: see {@link jiraConfigFromEnv}
 *  - Slack: SLACK_WEBHOOK_URL
 *  - Logs (Splunk): SPLUNK_URL + SPLUNK_TOKEN
 *  - LLM: LLM_BASE_URL + LLM_API_KEY + LLM_MODEL
 *
 *  CloudWatch Logs is intentionally not env-wired here: its SigV4 `signer`
 *  must be supplied by the host (see `CloudWatchConfig`), and
 *  AWS_REGION/AWS_ACCESS_KEY_* handling belongs to the host's AWS SDK setup.
 */
export function configFromEnv(env: Env = process.env): IntegrationsFromEnv {
  // When reading the real process environment, auto-load a repo-local .env
  // (if present) first; real shell variables are never overwritten.
  if (env === process.env) loadDotEnv({ env });
  const out: IntegrationsFromEnv = {};

  const jira = jiraConfigFromEnv(env);
  if (jira) out.jira = jira;

  const slackWebhookUrl = envVar(env, 'SLACK_WEBHOOK_URL');
  if (slackWebhookUrl) out.slack = new SlackWebhookNotifier({ webhookUrl: slackWebhookUrl });

  const splunkUrl = envVar(env, 'SPLUNK_URL');
  const splunkToken = envVar(env, 'SPLUNK_TOKEN');
  if (splunkUrl && splunkToken) {
    out.logs = new SplunkProvider({ baseUrl: splunkUrl, token: splunkToken });
  }

  const llm = llmConfigFromEnv(env);
  if (llm) out.llm = llm;

  return out;
}

export interface CreateAgentOptions extends SupportVoiceAgentConfig {
  /** Env source override (defaults to `process.env`); useful in tests. */
  env?: Env;
}

/** Production entry point: behavior options come from `config`, integration
 *  wiring falls back to the environment, and the runbook registry defaults to
 *  empty (sample actions live in `src/fixtures/sample-runbooks.ts`). */
export function createAgent(options: CreateAgentOptions = {}): SupportVoiceAgent {
  const { env = process.env, ...config } = options;
  const envConfig = configFromEnv(env);
  const merged: SupportVoiceAgentConfig = { ...config };
  merged.jira = config.jira ?? envConfig.jira;
  merged.logs = config.logs ?? envConfig.logs;
  merged.slack = config.slack ?? envConfig.slack;
  merged.runbooks = config.runbooks ?? new InMemoryRunbookProvider([]);
  return new SupportVoiceAgent(merged);
}

/** Create the LLM client from environment (or explicit config). Returns undefined when unwired. */
export function createLlmClient(options?: { env?: Env } | LlmConfig): OpenAiCompatibleClient | undefined {
  if ('baseUrl' in (options ?? {})) {
    return new OpenAiCompatibleClient(options as LlmConfig);
  }
  const envConfig = llmConfigFromEnv((options as { env?: Env })?.env);
  if (!envConfig) return undefined;
  return new OpenAiCompatibleClient(envConfig);
}

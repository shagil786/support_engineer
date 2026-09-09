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

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { RunbookAction } from './support-voice-agent/integrations/runbook';
import { loadDotEnv } from './env';
import * as h from './support-voice-agent/heuristics';
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
  /** Learning layer opt-in. Off by default — the operator must enable it.
   *  Interval configures the LearningLoop schedule (default 15 min). */
  learning?: { enabled: boolean; intervalMs?: number };
  /** APPROVAL_TIMEOUT_MS (>= 1000): how long a staged approval stays
   *  pending before it times out. Absent = the gate's built-in default. */
  approvalTimeoutMs?: number;
  /** DATA_DIR: root for all runtime data (events, outcomes, memory, stats,
   *  knowledge). Absent = 'var' under the process cwd — keep the default for
   *  local dev; production points this at a mounted volume. */
  dataDir?: string;
  /** RUNBOOKS_FILE: path to a JSON array of runbook actions
   *  [{ id, name, description, destructive }] the agent may offer/execute.
   *  The file is loaded and validated by the host; absent = no runbooks. */
  runbooksFile?: string;
  /** APPROVERS: comma-separated speaker ids trusted as admins (Slack user
   *  ids, console ids). The console speaker (SPEAKER) is always admin. */
  approvers?: string[];
  /** APPROVAL_CHANNEL: Slack channel for staged approvals
   *  (default: the gate's #support-agent-approvals). */
  approvalChannel?: string;
  /** Supervisor caps from env: SUPERVISOR_MAX_WALLCLOCK_MS (>= 1000),
   *  SUPERVISOR_MAX_HOPS (>= 1), SUPERVISOR_MAX_TOKENS (>= 1000),
   *  SUPERVISOR_MAX_IDENTICAL_TOOL_CALLS (>= 1). Absent keys = the
   *  supervisor's built-in defaults. */
  supervisorCaps?: import('./bootstrap.js').PlatformOptions['supervisorCaps'];
  /** Embedding backend for the knowledge base (absent = built-in hash
   *  embedder). Remote: OpenAI-compatible /embeddings (baseUrl/apiKey/model
   *  required together). Local: an in-process transformers.js model — no
   *  key, EMBEDDINGS_MODEL selects the HF model id (default MiniLM). */
  embeddings?:
    | { provider: 'remote'; baseUrl: string; apiKey: string; model: string; dim?: number }
    | { provider: 'local'; model?: string; dim?: number };
}

/** Embeddings config from the environment. Two providers:
 *
 *  - EMBEDDINGS_PROVIDER=local → in-process transformers.js model; no key,
 *    no URL; optional EMBEDDINGS_MODEL (HF id) and EMBEDDINGS_DIM.
 *  - EMBEDDINGS_PROVIDER=remote (or omitted — the legacy default) → an
 *    OpenAI-compatible /embeddings endpoint; EMBEDDINGS_BASE_URL,
 *    EMBEDDINGS_API_KEY and EMBEDDINGS_MODEL are required together (partial
 *    config is an error, never a silent half-wired embedder).
 *
 *  EMBEDDINGS_DIM (>= 8) folds longer vectors to a fixed dimension. */
export function embeddingsFromEnv(env: Env): IntegrationsFromEnv['embeddings'] {
  const provider = envVar(env, 'EMBEDDINGS_PROVIDER')?.toLowerCase();
  const baseUrl = envVar(env, 'EMBEDDINGS_BASE_URL');
  const apiKey = envVar(env, 'EMBEDDINGS_API_KEY');
  const model = envVar(env, 'EMBEDDINGS_MODEL');
  const dimRaw = Number(envVar(env, 'EMBEDDINGS_DIM') ?? 0);
  const dim = Number.isFinite(dimRaw) && dimRaw >= 8 ? dimRaw : undefined;

  if (provider === 'local') {
    if (baseUrl || apiKey) {
      throw new Error('embeddings config contradiction: EMBEDDINGS_PROVIDER=local runs in-process and takes no EMBEDDINGS_BASE_URL/EMBEDDINGS_API_KEY');
    }
    return { provider: 'local', ...(model ? { model } : {}), ...(dim !== undefined ? { dim } : {}) };
  }
  if (provider && provider !== 'remote') {
    throw new Error(`unknown EMBEDDINGS_PROVIDER '${provider}' (known: local, remote)`);
  }
  if (!baseUrl || !apiKey || !model) {
    if (baseUrl || apiKey || model) {
      throw new Error('embeddings config incomplete: EMBEDDINGS_BASE_URL, EMBEDDINGS_API_KEY and EMBEDDINGS_MODEL are required together');
    }
    return undefined;
  }
  return { provider: 'remote', baseUrl, apiKey, model, ...(dim !== undefined ? { dim } : {}) };
}

/** Learning layer opt-in: LEARNING_ENABLED=true|1 enables it. Defaults to
 *  false — the agent never learns or suggests policy changes unless the
 *  operator explicitly turns this on. LEARNING_INTERVAL_MS (>= 1000) sets
 *  the LearningLoop tick interval. */
export function learningEnabledFromEnv(env: Env = process.env): { enabled: boolean; intervalMs?: number } {
  const raw = envVar(env, 'LEARNING_ENABLED')?.toLowerCase();
  const enabled = raw === 'true' || raw === '1';
  if (!enabled) return { enabled: false };
  const rawMs = Number(envVar(env, 'LEARNING_INTERVAL_MS') ?? 0);
  const intervalMs = Number.isFinite(rawMs) && rawMs >= 1000 ? rawMs : undefined;
  return { enabled, ...(intervalMs !== undefined ? { intervalMs } : {}) };
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
  const timeoutMsRaw = envVar(env, 'LLM_TIMEOUT_MS');
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : undefined;
  return {
    baseUrl,
    apiKey,
    model,
    ...(timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };
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
/** Load an org's runbook catalog from a JSON file (RUNBOOKS_FILE). Fails
 *  LOUD on a missing or malformed file: an operator who points the agent at
 *  a catalog wants that catalog, and an empty-by-accident registry would
 *  silently downgrade every runbook offer to 'unwired'. */
export function runbooksFromFile(path: string): RunbookAction[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`RUNBOOKS_FILE ${path} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`RUNBOOKS_FILE ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const Schema = z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
      destructive: z.boolean(),
    }),
  );
  const result = Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`RUNBOOKS_FILE ${path} does not match RunbookAction[] ({ id, name, description, destructive }): ${result.error.message}`);
  }
  return result.data;
}

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

  // Absent = not wired (learning disabled), consistent with the other
  // integrations: an empty environment still yields an empty wiring set.
  const learning = learningEnabledFromEnv(env);
  if (learning.enabled) out.learning = learning;

  const approvalRawMs = Number(envVar(env, 'APPROVAL_TIMEOUT_MS') ?? 0);
  if (Number.isFinite(approvalRawMs) && approvalRawMs >= 1000) out.approvalTimeoutMs = approvalRawMs;

  // Supervisor caps: each env var is optional and floor-checked independently,
  // so operators can raise just the wall clock for slow LLM providers.
  const num = (name: string, min: number) => {
    const v = Number(envVar(env, name) ?? NaN);
    return Number.isFinite(v) && v >= min ? v : undefined;
  };
  const caps = {
    ...(num('SUPERVISOR_MAX_WALLCLOCK_MS', 1000) !== undefined ? { maxWallClockMs: num('SUPERVISOR_MAX_WALLCLOCK_MS', 1000) } : {}),
    ...(num('SUPERVISOR_MAX_HOPS', 1) !== undefined ? { maxHops: num('SUPERVISOR_MAX_HOPS', 1) } : {}),
    ...(num('SUPERVISOR_MAX_TOKENS', 1000) !== undefined ? { maxTokens: num('SUPERVISOR_MAX_TOKENS', 1000) } : {}),
    ...(num('SUPERVISOR_MAX_IDENTICAL_TOOL_CALLS', 1) !== undefined
      ? { maxIdenticalToolCalls: num('SUPERVISOR_MAX_IDENTICAL_TOOL_CALLS', 1) }
      : {}),
  } as NonNullable<typeof out.supervisorCaps>;
  if (Object.keys(caps).length > 0) out.supervisorCaps = caps;

  const embeddings = embeddingsFromEnv(env);
  if (embeddings) out.embeddings = embeddings;

  // Portability kit: same binary, any org — data location, runbook catalog,
  // approver identities and approval channel are all deployment config.
  const dataDir = envVar(env, 'DATA_DIR')?.trim();
  if (dataDir) out.dataDir = dataDir;
  const approvers = (envVar(env, 'APPROVERS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (approvers.length > 0) out.approvers = approvers;
  const approvalChannel = envVar(env, 'APPROVAL_CHANNEL')?.trim();
  if (approvalChannel) out.approvalChannel = approvalChannel;
  const runbooksFile = envVar(env, 'RUNBOOKS_FILE')?.trim();
  if (runbooksFile) out.runbooksFile = runbooksFile;

  return out;
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

/** Real LLM client — OpenAI-compatible HTTP. No hardcoded keys or hosts. */
import { TOOL_SCHEMAS } from './types.js';
import type { ToolSchema } from './types.js';

export interface LlmConfig {
  baseUrl: string;          // e.g. "https://api.openai.com/v1", "http://localhost:11434/v1", "https://openrouter.ai/api/v1"
  apiKey: string;           // empty string = unwired
  model: string;            // e.g. "gpt-4o", "llama3", "mistral"
  timeoutMs?: number;       // default 30_000
  /** Retries for transient failures (429 / 5xx / network), exponential
   *  backoff. Default 2; 0 disables. Latency budget: each retry gets the
   *  full per-attempt timeout. */
  maxRetries?: number;
  /** Base backoff in ms (default 500): delay = base * 2^attempt (capped 8s). */
  retryBackoffMs?: number;
  /** Injectable fetch for tests / proxies. */
  request?: typeof fetch;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string; // for tool role
}

export interface LlmChatRequest {
  messages: LlmMessage[];
  tools: OpenAiFunctionTool[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

export interface LlmChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: LlmMessage;
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class LlmError extends Error {
  constructor(
    public readonly code: 'unwired' | 'network' | 'http_error' | 'malformed',
    message: string,
    public readonly detail?: unknown
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmClient {
  isWired(): boolean;
  complete(request: LlmChatRequest): Promise<LlmChatResponse>;
}

export class OpenAiCompatibleClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly http: typeof fetch;

  constructor(config: LlmConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBackoffMs = config.retryBackoffMs ?? 500;
    this.http = config.request ?? fetch;
  }

  isWired(): boolean {
    return this.apiKey.length > 0 && this.baseUrl.length > 0 && this.model.length > 0;
  }

  async complete(request: LlmChatRequest): Promise<LlmChatResponse> {
    if (!this.isWired()) {
      throw new LlmError('unwired', 'LLM not configured — set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL');
    }

    const body = {
      model: this.model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tool_choice ?? 'auto',
      temperature: request.temperature ?? 0.2,
      max_tokens: request.max_tokens ?? 1024,
    };

    // Retry transient failures (429 / 5xx / network) with exponential
    // backoff — capacity-limited providers (e.g. inferX "all replicas at
    // capacity") reject fast, so a short retry ladder recovers most
    // requests. 4xx others are permanent and never retried.
    let lastError: LlmError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(this.retryBackoffMs * 2 ** (attempt - 1), 8_000);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        return await this.attempt(body);
      } catch (e) {
        if (!(e instanceof LlmError) || !this.isRetryable(e)) throw e;
        lastError = e;
      }
    }
    throw lastError ?? new LlmError('http_error', 'LLM request failed after retries');
  }

  private isRetryable(e: LlmError): boolean {
    if (e.code === 'network') return true;
    if (e.code === 'http_error') {
      const status = Number(/^LLM HTTP (\d+)$/.exec(e.message)?.[1] ?? 0);
      return status === 429 || status >= 500;
    }
    return false;
  }

  private async attempt(body: unknown): Promise<LlmChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new LlmError('network', 'LLM request timed out');
      }
      throw new LlmError('network', 'LLM request failed', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let detail: unknown;
      try {
        detail = await response.json();
      } catch {
        detail = await response.text().catch(() => 'no body');
      }
      throw new LlmError('http_error', `LLM HTTP ${response.status}`, detail);
    }

    let data: LlmChatResponse;
    try {
      data = await response.json();
    } catch (e) {
      throw new LlmError('malformed', 'LLM response not valid JSON', e instanceof Error ? e.message : String(e));
    }

    // Basic shape validation
    const firstChoice = data.choices?.[0];
    if (!firstChoice || !firstChoice.message) {
      throw new LlmError('malformed', 'LLM response missing choices[0].message', data);
    }

    return data;
  }
}

/** OpenAI wire format for a function tool (type wrapper + nested function). */
export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolSchema['parameters'];
  };
}

/** Convert our TOOL_SCHEMAS to the OpenAI tools array format. Real
 *  OpenAI-compatible endpoints (OpenAI, NVIDIA NIM, Ollama, OpenRouter…)
 *  require the `{ type: 'function', function: {...} }` wrapper. */
export function schemasToOpenAiTools(): OpenAiFunctionTool[] {
  return Object.values(TOOL_SCHEMAS).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

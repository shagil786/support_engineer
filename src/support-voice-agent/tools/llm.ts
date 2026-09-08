/** Real LLM client — OpenAI-compatible HTTP. No hardcoded keys or hosts.
 *
 *  Transient-failure handling has two layers:
 *  1. Retry ladder: per-request exponential backoff with ±25% jitter —
 *     recovers from single blips and short capacity windows.
 *  2. Saturation circuit breaker (agentic-ai failure handling): when 429
 *     completions trip the breaker, further requests fail fast with
 *     `circuit_open` instead of burning the ladder against a provider that
 *     is saturated anyway; after a cooldown one half-open probe decides
 *     reset vs re-open. The cooldown doubles per re-trip (capped), so a
 *     saturation window that outlasts the retry ladder stops hammering the
 *     provider — 5xx/network errors retry as before but never open it. */
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
  /** Observability hook (agentic-ai: log every LLM call). Fired once per
   *  complete() — success or failure — with model, total latency, attempt
   *  count, and usage when the provider returned it. Never receives prompt
   *  or response content. */
  onCall?: (info: {
    model: string;
    latencyMs: number;
    attempts: number;
    ok: boolean;
    errorCode?: string;
    promptTokens?: number;
    completionTokens?: number;
    /** Set when the call was rejected by the saturation circuit breaker. */
    breakerState?: number;
  }) => void;
  /** Consecutive 429-saturated completions that open the circuit breaker
 *  (default 3; 0 disables the breaker entirely). */
  breakerThreshold?: number;
  /** First cooldown after the breaker opens, ms (default 10_000). Doubles
 *  per re-trip up to breakerMaxCooldownMs; a success resets it. */
  breakerBaseCooldownMs?: number;
  /** Upper bound for the doubling cooldown, ms (default 120_000). */
  breakerMaxCooldownMs?: number;
  /** Injectable clock for breaker timing (tests); default Date.now. */
  now?: () => number;
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
    public readonly code: 'unwired' | 'network' | 'http_error' | 'malformed' | 'circuit_open',
    message: string,
    public readonly detail?: unknown,
    /** True when the provider explicitly asked callers to slow down (429). */
    public readonly rateLimited?: boolean
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
  private readonly onCall: LlmConfig['onCall'];
  private readonly http: typeof fetch;
  // Saturation circuit breaker state (see file header). consecutive429 only
  // counts completions, never ladder attempts, so maxRetries cannot open the
  // breaker on its own — a single overloaded request retries, it does not
  // lock callers out.
  private consecutive429 = 0;
  private openUntilMs = 0;
  private probing = false;
  private cooldownMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerBaseCooldownMs: number;
  private readonly breakerMaxCooldownMs: number;
  private readonly now: () => number;

  constructor(config: LlmConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBackoffMs = config.retryBackoffMs ?? 500;
    this.onCall = config.onCall;
    this.http = config.request ?? fetch;
    this.breakerThreshold = config.breakerThreshold ?? 3;
    this.breakerBaseCooldownMs = config.breakerBaseCooldownMs ?? 10_000;
    this.breakerMaxCooldownMs = config.breakerMaxCooldownMs ?? 120_000;
    this.cooldownMs = this.breakerBaseCooldownMs;
    this.now = config.now ?? Date.now;
  }

  isWired(): boolean {
    return this.apiKey.length > 0 && this.baseUrl.length > 0 && this.model.length > 0;
  }

  async complete(request: LlmChatRequest): Promise<LlmChatResponse> {
    if (!this.isWired()) {
      throw new LlmError('unwired', 'LLM not configured — set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL');
    }

    // Some OpenAI-compatible gateways (e.g. inferX) reject `tools: []` —
    // "provide at least one tool or omit the field entirely" — so empty
    // tool arrays are omitted along with tool_choice.
    const hasTools = request.tools.length > 0;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.max_tokens ?? 1024,
    };
    if (hasTools) {
      body['tools'] = request.tools;
      body['tool_choice'] = request.tool_choice ?? 'auto';
    }

    // Retry transient failures (429 / 5xx / network) with exponential
    // backoff — capacity-limited providers (e.g. inferX "all replicas at
    // capacity") reject fast, so a short retry ladder recovers most
    // requests. 4xx others are permanent and never retried.
    let lastError: LlmError | undefined;
    const started = Date.now();
    let attempts = 0;
    // Saturation circuit breaker: while open, fail fast without touching the
    // provider (the ladder cannot fix a provider that is out of capacity).
    const breakerState = this.breakerCheck();
    if (breakerState !== null) {
      this.onCall?.({ model: this.model, latencyMs: Date.now() - started, attempts: 0, ok: false, errorCode: 'circuit_open', breakerState });
      throw new LlmError('circuit_open', `LLM saturated — circuit open for another ${breakerState}ms`);
    }
    try {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      attempts = attempt + 1;
      if (attempt > 0) {
        const delay = this.jittered(this.retryBackoffMs, attempt);
        console.error(`[llm] retry ${attempt}/${this.maxRetries} after ${Math.round(delay)}ms: ${lastError?.code ?? 'unknown'}`);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        const r = await this.attempt(body);
        this.breakerReset(); // success closes the circuit and clears the count
        this.onCall?.({
          model: this.model,
          latencyMs: Date.now() - started,
          attempts,
          ok: true,
          ...(r.usage ? { promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens } : {}),
        });
        return r;
      } catch (e) {
        if (!(e instanceof LlmError) || !this.isRetryable(e)) {
          this.onCall?.({
            model: this.model,
            latencyMs: Date.now() - started,
            attempts,
            ok: false,
            ...(e instanceof LlmError ? { errorCode: e.code } : {}),
          });
          throw e;
        }
        lastError = e;
      }
    }
    // One saturated completion (every ladder attempt 429'd) counts once —
    // a single overloaded request retries, it never opens the breaker alone.
    if (lastError?.rateLimited) this.recordSaturation();
    const exhausted = lastError ?? new LlmError('http_error', 'LLM request failed after retries');
    this.onCall?.({
      model: this.model,
      latencyMs: Date.now() - started,
      attempts,
      ok: false,
      errorCode: exhausted.code,
    });
    throw exhausted;
    } finally {
      // Whatever way this call ends (success, permanent error, ladder
      // exhausted), the probe it may have been is finished.
      this.probing = false;
    }
  }

  /** Saturation circuit breaker gate — null = admit, otherwise the ms
   *  remaining before the half-open probe. Admission when the cooldown has
   *  elapsed happens exactly once (the probe); concurrent callers while the
   *  probe is in flight keep failing fast. */
  private breakerCheck(): number | null {
    if (this.breakerThreshold <= 0) return null;
    const now = this.now();
    if (this.openUntilMs > now) return this.openUntilMs - now;
    if (this.openUntilMs > 0) {
      if (this.probing) return 1; // a probe is already in flight
      this.probing = true; // half-open: this call is the probe
    }
    return null;
  }

  /** Count a 429-saturated completion (all ladder attempts exhausted);
   *  when consecutive saturated completions reach the threshold, open the
   *  circuit and grow the cooldown (doubling per re-trip, capped). */
  private recordSaturation(): void {
    if (this.breakerThreshold <= 0) return;
    this.consecutive429 += 1;
    if (this.consecutive429 >= this.breakerThreshold) {
      this.openUntilMs = this.now() + this.cooldownMs;
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.breakerMaxCooldownMs);
      console.error(`[llm] circuit breaker OPEN after ${this.consecutive429} saturated completions`);
    }
  }

  /** Reset all breaker state (a successful call — including the half-open
   *  probe — closes the circuit). */
  private breakerReset(): void {
    this.consecutive429 = 0;
    this.openUntilMs = 0;
    this.cooldownMs = this.breakerBaseCooldownMs;
    this.probing = false;
  }

  /** Backoff delay with ±25% jitter: 500 * 2^(attempt-1), capped 8s. Jitter
   *  keeps many concurrent callers from retrying in lockstep against a
   *  saturated provider. */
  private jittered(baseMs: number, attempt: number): number {
    const base = Math.min(baseMs * 2 ** (attempt - 1), 8_000);
    const spread = base * 0.25;
    return base - spread + Math.random() * spread * 2;
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
      throw new LlmError('http_error', `LLM HTTP ${response.status}`, detail, response.status === 429);
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

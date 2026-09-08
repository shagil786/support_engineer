import { describe, it, expect } from 'vitest';
import { OpenAiCompatibleClient, LlmError, schemasToOpenAiTools } from '../src/support-voice-agent/tools/llm.ts';
import { TOOL_SCHEMAS } from '../src/support-voice-agent/tools/types.ts';
import type { LlmChatRequest } from '../src/support-voice-agent/tools/llm.ts';

/* Deterministic fake fetch — records requests, returns canned responses. */
function fakeFetch(status: number, body: unknown, captured: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []) {
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  };
  return { fn: fn as unknown as typeof fetch, captured };
}

const minimalResponse = {
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Got it.' }, finish_reason: 'stop' }],
};

describe('OpenAiCompatibleClient', () => {
  it('reports every complete() to the onCall hook: attempts, latency, usage, ok/errorCode', async () => {
    let calls = 0;
    const fakeFetch = async (_url: string, init?: { body?: string }) => {
      calls++;
      if (calls === 1) return new Response('server busy', { status: 429 });
      return Response.json({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    };
    const seen: Array<Record<string, unknown>> = [];
    const client = new OpenAiCompatibleClient({
      baseUrl: 'http://x', apiKey: 'k', model: 'm',
      request: fakeFetch as unknown as typeof fetch,
      onCall: (info) => seen.push(info as Record<string, unknown>),
    });
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(seen.length).toBe(1);
    const info = seen[0] as { model: string; attempts: number; ok: boolean; promptTokens: number; completionTokens: number; latencyMs: number };
    expect(info.model).toBe('m');
    expect(info.attempts).toBe(2); // one 429, then success
    expect(info.ok).toBe(true);
    expect(info.promptTokens).toBe(10);
    expect(info.completionTokens).toBe(5);
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed complete() with the error code and zero usage', async () => {
    const fakeFetch = async () => new Response('nope', { status: 400 });
    const seen: Array<Record<string, unknown>> = [];
    const client = new OpenAiCompatibleClient({
      baseUrl: 'http://x', apiKey: 'k', model: 'm',
      request: fakeFetch as unknown as typeof fetch,
      onCall: (info) => seen.push(info as Record<string, unknown>),
    });
    await expect(client.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] })).rejects.toThrow();
    expect(seen.length).toBe(1);
    const info = seen[0] as { ok: boolean; errorCode?: string; attempts: number };
    expect(info.ok).toBe(false);
    expect(info.errorCode).toBeTruthy();
    expect(info.attempts).toBe(1); // 4xx never retried
  });

  it('adds jitter within ±25% of the backoff delay', () => {
    const client = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    const fn = (client as unknown as { jittered: (base: number, attempt: number) => number }).jittered;
    for (let i = 0; i < 50; i++) {
      const d = fn.call(client, 500, 1);
      expect(d).toBeGreaterThanOrEqual(375);
      expect(d).toBeLessThanOrEqual(625);
    }
  });

  describe('wiring', () => {
  it('is unwired when key/baseUrl/model missing and throws LlmError unwired', async () => {
    const client = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    expect(client.isWired()).toBe(false);
    await expect(client.complete({ messages: [], tools: [] })).rejects.toThrow(/not configured/);
  });

  it('posts the OpenAI tool-calling shape to <baseUrl>/chat/completions', async () => {
    const { fn, captured } = fakeFetch(200, minimalResponse);
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://gateway.test/v1/',
      apiKey: 'test-key',
      model: 'test-model',
      request: fn,
    });
    const req: LlmChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: schemasToOpenAiTools(),
    };
    const res = await client.complete(req);
    expect(res.choices[0]?.message.content).toBe('Got it.');
    const sent = captured[0];
    expect(sent?.url).toBe('https://gateway.test/v1/chat/completions');
    expect(sent?.headers.Authorization).toBe('Bearer test-key');
    expect(sent?.body.model).toBe('test-model');
    expect(Array.isArray(sent?.body.tools)).toBe(true);
    // OpenAI wire format: each tool wrapped in { type: 'function', function: {...} }
    const first = (sent?.body.tools as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(first.type).toBe('function');
    expect((first.function as Record<string, unknown>).name).toBe('jira_create_issue');
    expect(sent?.body.tool_choice).toBe('auto');
  });

  it('throws LlmError http_error with detail on non-2xx', async () => {
    const { fn } = fakeFetch(400, { error: { message: 'bad payload' } });
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'test-key', model: 'm', request: fn });
    const p = client.complete({ messages: [], tools: [] });
    await expect(p).rejects.toBeInstanceOf(LlmError);
    await expect(p).rejects.toMatchObject({ code: 'http_error' });
  });

  it('throws LlmError malformed when response lacks choices', async () => {
    const { fn } = fakeFetch(200, { id: 'x', choices: [] });
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'test-key', model: 'm', request: fn });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toMatchObject({ code: 'malformed' });
  });

  it('throws LlmError network when fetch rejects', async () => {
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'test-key', model: 'm', maxRetries: 0, request: failing });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toMatchObject({ code: 'network' });
  });

  it('retries a 429 and succeeds on a later attempt (capacity recovery)', async () => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      if (calls < 3) {
        return { ok: false, status: 429, json: async () => ({ error: 'capacity' }), text: async () => 'capacity' } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => minimalResponse, text: async () => JSON.stringify(minimalResponse) } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 3, retryBackoffMs: 1, request: fn });
    const r = await client.complete({ messages: [], tools: [] });
    expect(calls).toBe(3);
    expect(r.choices[0]?.message?.content).toBe('Got it.');
  });

  it('never retries a permanent 4xx (401 fails immediately)', async () => {
    let calls = 0;
    const fn = (async (): Promise<Response> => {
      calls += 1;
      return { ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 3, retryBackoffMs: 1, request: fn });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toMatchObject({ code: 'http_error' });
    expect(calls).toBe(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    let calls = 0;
    const fn = (async (): Promise<Response> => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({}), text: async () => 'overloaded' } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 2, retryBackoffMs: 1, request: fn });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toMatchObject({ code: 'http_error', message: /503/ });
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  describe('saturation circuit breaker', () => {
    /** Provider that always answers 429, counting its hits. */
    function busy429(): { request: typeof fetch; calls: () => number } {
      let calls = 0;
      const request = (async (): Promise<Response> => {
        calls += 1;
        return { ok: false, status: 429, json: async () => ({}), text: async () => 'capacity' } as unknown as Response;
      }) as unknown as typeof fetch;
      return { request, calls: () => calls };
    }
    const busyBody = { messages: [], tools: [] };

    it('opens after consecutive 429 completions and fails fast with circuit_open', async () => {
      const { request, calls } = busy429();
      const clock = { now: 1_000 };
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 1, retryBackoffMs: 1, request, now: () => clock.now });
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 1
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 2
      expect(calls()).toBe(4); // each completion still reached the provider
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 3 → opens
      expect(calls()).toBe(6);
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'circuit_open' }); // fail fast, provider untouched
      expect(calls()).toBe(6);
    });

    it('half-opens after the cooldown: a probe that succeeds resets the breaker', async () => {
      let calls = 0;
      const request = (async (): Promise<Response> => {
        calls += 1;
        if (calls <= 3) return { ok: false, status: 429, json: async () => ({}), text: async () => 'capacity' } as unknown as Response;
        return { ok: true, status: 200, json: async () => minimalResponse, text: async () => JSON.stringify(minimalResponse) } as unknown as Response;
      }) as unknown as typeof fetch;
      const clock = { now: 1_000 };
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 0, breakerBaseCooldownMs: 1_000, request, now: () => clock.now });
      for (let i = 0; i < 3; i++) {
        await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' });
      }
      clock.now += 999; // cooldown (1000ms) not yet elapsed
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'circuit_open' });
      clock.now += 1; // elapsed → half-open: exactly one probe goes through
      const r = await client.complete(busyBody);
      expect(r.choices[0]?.message?.content).toBe('Got it.');
      expect(calls).toBe(4);
    });

    it('each re-trip doubles the cooldown', async () => {
      const { request, calls } = busy429();
      const clock = { now: 1_000 };
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 0, breakerThreshold: 2, breakerBaseCooldownMs: 1_000, request, now: () => clock.now });
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 1
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 2 → open, cooldown 1s
      clock.now += 999;
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'circuit_open' });
      clock.now += 1; // +1000 → half-open probe 429s → re-trip, cooldown 2s
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' });
      clock.now += 1999; // only +1999 since the re-trip → still open
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'circuit_open' });
      clock.now += 1; // +2000 → half-open probe runs
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' });
      expect(calls()).toBe(4);
    });

    it('resets fully on success: the next saturation starts from zero', async () => {
      let calls = 0;
      const request = (async (): Promise<Response> => {
        calls += 1;
        return calls === 3
          ? ({ ok: true, status: 200, json: async () => minimalResponse, text: async () => JSON.stringify(minimalResponse) } as unknown as Response)
          : ({ ok: false, status: 429, json: async () => ({}), text: async () => 'capacity' } as unknown as Response);
      }) as unknown as typeof fetch;
      const clock = { now: 1_000 };
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 0, breakerThreshold: 2, breakerBaseCooldownMs: 1_000, request, now: () => clock.now });
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 1
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 2 → open
      clock.now += 1_001;
      const r = await client.complete(busyBody); // half-open probe → success → reset
      expect(r.choices[0]?.message?.content).toBe('Got it.');
      expect(calls).toBe(3);
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // one 429 → trip 1, not open
      expect(calls).toBe(4);
      clock.now += 1_000;
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 2: this call opens the breaker
      expect(calls).toBe(5);
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'circuit_open' }); // next call fails fast
      expect(calls).toBe(5);
    });

    it('does not count 5xx toward the breaker', async () => {
      let calls = 0;
      const request = (async (): Promise<Response> => {
        calls += 1;
        return { ok: false, status: 503, json: async () => ({}), text: async () => 'overloaded' } as unknown as Response;
      }) as unknown as typeof fetch;
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 1, retryBackoffMs: 1, request, now: () => 1_000 });
      for (let i = 0; i < 4; i++) {
        await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' });
      }
      expect(calls).toBe(8); // every completion reached the provider — never circuit_open
    });

    it('breakerThreshold: 0 disables the breaker entirely', async () => {
      const { request, calls } = busy429();
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 0, breakerThreshold: 0, request });
      for (let i = 0; i < 5; i++) {
        await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' });
      }
      expect(calls()).toBe(5);
    });

    it('reports circuit_open through the onCall hook with attempts: 0', async () => {
      const { request } = busy429();
      const seen: Array<Record<string, unknown>> = [];
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'k', model: 'm', maxRetries: 0, breakerThreshold: 1, request, now: () => 1_000, onCall: (info) => seen.push(info as Record<string, unknown>) });
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'http_error' }); // trip 1 → open
      await expect(client.complete(busyBody)).rejects.toMatchObject({ code: 'circuit_open' });
      const last = seen[seen.length - 1] as { ok: boolean; errorCode?: string; attempts: number; breakerState?: string };
      expect(last.ok).toBe(false);
      expect(last.errorCode).toBe('circuit_open');
      expect(last.attempts).toBe(0);
      expect(last.breakerState).toBeGreaterThan(0); // ms remaining on the cooldown
    });
  });
});

describe('tool registry schemas', () => {
  it('defines the five required tools with spec names', () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([
      'execute_runbook_script', 'invoke_human_on_slack', 'jira_create_issue', 'meeting_interrupt', 'query_logs',
    ]);
  });

  it('jira_create_issue schema matches the spec enums and required fields', () => {
    const s = TOOL_SCHEMAS.jira_create_issue.parameters;
    expect(s.properties.issue_type.enum).toEqual(['Bug', 'Task', 'Story']);
    expect(s.properties.priority.enum).toEqual(['Highest', 'High', 'Medium']);
    expect(s.required).toEqual(['project_key', 'summary', 'issue_type']);
  });

  it('serialize to the OpenAI tools array format (type wrapper)', () => {
    const tools = schemasToOpenAiTools();
    expect(tools).toHaveLength(5);
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(typeof t.function.description).toBe('string');
      expect(t.function.parameters.type).toBe('object');
    }
    expect(Object.values(TOOL_SCHEMAS).map((x) => x.name).sort()).toEqual(
      tools.map((t) => t.function.name).sort(),
    );
  });
});
});

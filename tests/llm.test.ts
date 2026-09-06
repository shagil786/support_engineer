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

describe('OpenAiCompatibleClient wiring', () => {
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
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://gw.test/v1', apiKey: 'test-key', model: 'm', request: failing });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toMatchObject({ code: 'network' });
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

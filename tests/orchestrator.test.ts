import { describe, it, expect } from 'vitest';
import { LlmOrchestrator, DEFAULT_SYSTEM_PROMPT } from '../src/support-voice-agent/tools/orchestrator.ts';
import { handlers } from '../src/support-voice-agent/tools/handlers.ts';
import { LlmError } from '../src/support-voice-agent/tools/llm.ts';
import type { LlmClient, LlmChatRequest, LlmChatResponse } from '../src/support-voice-agent/tools/llm.ts';
import type { ToolDependencies } from '../src/support-voice-agent/tools/types.ts';

/* --------- fake integrations (dependency injection, no network) --------- */

function makeDeps(overrides: Partial<ToolDependencies> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const posted: Array<{ channel: string; text: string }> = [];
  const executed: string[] = [];
  const spoken: string[] = [];
  const deps: ToolDependencies = {
    jiraClient: {
      createIssue: async (opts) => {
        created.push(opts as unknown as Record<string, unknown>);
        return { key: 'SUP-42', id: '42', self: 'https://jira.test/SUP-42' };
      },
    } as ToolDependencies['jiraClient'],
    slackNotifier: {
      postMessage: async (channel, text) => { posted.push({ channel, text }); },
    },
    runbookProvider: {
      list: () => [{ id: 'restart-cache', name: 'Restart cache', description: 'restart the cache pod', destructive: false }],
      run: async (actionId) => { executed.push(actionId); return { actionId, ok: true, output: 'restarted' }; },
    },
    logProvider: {
      name: 'fake',
      query: async (q) => ({ rows: [{ timestamp: '2026-09-06T00:00:00Z', message: `matched ${q.query}` }], provider: 'fake' }),
    },
    speak: (t) => spoken.push(t),
    ...overrides,
  };
  return { deps, created, posted, executed, spoken };
}

/* Scripted LLM: returns queued responses in order; records every request. */
class ScriptedLlm implements LlmClient {
  readonly requests: LlmChatRequest[] = [];
  constructor(private readonly script: LlmChatResponse[]) {}
  isWired() { return true; }
  async complete(req: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(req);
    const next = this.script[this.requests.length - 1];
    if (!next) throw new LlmError('malformed', 'script exhausted');
    return next;
  }
}

const textResponse = (content: string): LlmChatResponse => ({
  id: 'r', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

const toolCallResponse = (calls: Array<{ id: string; name: string; args: string }>): LlmChatResponse => ({
  id: 'r',
  choices: [{
    index: 0,
    message: { role: 'assistant', tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } })) },
    finish_reason: 'tool_calls',
  }],
});

describe('handler degradation (unwired integrations)', () => {
  it('returns structured error, never throws, when backend unwired', async () => {
    const empty: ToolDependencies = {};
    const r1 = await handlers.jira_create_issue({ project_key: 'S', summary: 'x', issue_type: 'Bug' }, empty);
    expect(r1.ok).toBe(false);
    const r2 = await handlers.query_logs({ query_string: 'err' }, empty);
    expect(r2.ok).toBe(false);
    const r3 = await handlers.execute_runbook_script({ script_name: 'a' }, empty);
    expect(r3.ok).toBe(false);
    const r4 = await handlers.invoke_human_on_slack({ target_user: 'u', message: 'm' }, empty);
    expect(r4.ok).toBe(false);
    const r5 = await handlers.meeting_interrupt({ message: 'm' }, empty);
    expect(r5.ok).toBe(false);
  });

  it('jira handler maps args through jiraPriorityName and returns ticket id', async () => {
    const { deps, created } = makeDeps();
    const r = await handlers.jira_create_issue(
      { project_key: 'SUP', summary: 'iOS crash', issue_type: 'Bug', priority: 'Highest', description: 'login crash' },
      deps,
    );
    expect(r).toEqual({ ok: true, data: { ticket_id: 'SUP-42', url: 'https://jira.test/SUP-42' } });
    expect(created[0]).toMatchObject({ summary: 'iOS crash', issueType: 'Bug', priority: 'Highest' });
  });

  it('query handler passes parsed time range and returns rows', async () => {
    const { deps } = makeDeps();
    const r = await handlers.query_logs({ query_string: 'NullPointerException', time_range: 'last_1h' }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { provider: string; rows: unknown[]; time_range: string };
      expect(data.provider).toBe('fake');
      expect(data.rows).toHaveLength(1);
      expect(data.time_range).toBe('last_1h');
    }
  });
});

describe('LlmOrchestrator', () => {
  it('falls back to deterministic brain when unwired', async () => {
    const { deps } = makeDeps();
    const orch = new LlmOrchestrator({ deps, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    const res = await orch.process('what is the status?');
    expect(res.fallbackToDeterministic).toBe(true);
    expect(res.speech).toBe('');
  });

  it('tool_calls round-trip: executes against injected fakes and feeds results back', async () => {
    const { deps, created } = makeDeps();
    const llm = new ScriptedLlm([
      toolCallResponse([{ id: 'c1', name: 'jira_create_issue', args: JSON.stringify({ project_key: 'SUP', summary: 'iOS login crash', issue_type: 'Bug', priority: 'Highest' }) }]),
      textResponse('Created SUP-42 with highest priority.'),
    ]);
    const orch = new LlmOrchestrator({ llm, deps, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    const res = await orch.process('log a bug: iOS login screen crashes');
    expect(created).toHaveLength(1);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]?.name).toBe('jira_create_issue');
    expect(res.speech).toBe('Created SUP-42 with highest priority.');
    expect(res.fallbackToDeterministic).toBe(false);
    // second LLM request must contain a tool-role message with the result
    const secondReq = llm.requests[1];
    const toolMsg = secondReq?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('SUP-42');
  });

  it('executes multiple parallel tool calls in one round', async () => {
    const { deps, created } = makeDeps();
    const llm = new ScriptedLlm([
      toolCallResponse([
        { id: 'a', name: 'jira_create_issue', args: JSON.stringify({ project_key: 'SUP', summary: 'bug A', issue_type: 'Bug' }) },
        { id: 'b', name: 'query_logs', args: JSON.stringify({ query_string: 'payment 500' }) },
      ]),
      textResponse('Logged SUP-42; found a matching 500 in payment-api logs.'),
    ]);
    const orch = new LlmOrchestrator({ llm, deps, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    const res = await orch.process('payment API is down — check logs and file a bug');
    expect(res.toolCalls).toHaveLength(2);
    expect(created).toHaveLength(1); // jira executed
    const toolMsgs = llm.requests[1]?.messages.filter((m) => m.role === 'tool') ?? [];
    expect(toolMsgs).toHaveLength(2); // both results fed back
  });

  it('meeting_interrupt tool speaks critical prefix through injected speak', async () => {
    const { deps, spoken } = makeDeps();
    const llm = new ScriptedLlm([
      toolCallResponse([{ id: 'i', name: 'meeting_interrupt', args: JSON.stringify({ message: 'P1 on payment-api', urgency: 'critical' }) }]),
      textResponse('Alerted the meeting.'),
    ]);
    const orch = new LlmOrchestrator({ llm, deps, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    await orch.process('we have a critical incident');
    expect(spoken[0]).toBe('Excuse me, urgent alert: P1 on payment-api');
  });

  it('returns unwired fallback when LLM throws unwired mid-flight', async () => {
    const { deps } = makeDeps();
    const unwiredLlm: LlmClient = { isWired: () => true, complete: async () => { throw new LlmError('unwired', 'gone'); } };
    const orch = new LlmOrchestrator({ llm: unwiredLlm, deps, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    const res = await orch.process('anything');
    expect(res.fallbackToDeterministic).toBe(true);
  });

  it('LLM HTTP failure falls back with error, does not throw', async () => {
    const { deps } = makeDeps();
    const brokenLlm: LlmClient = { isWired: () => true, complete: async () => { throw new LlmError('http_error', '500'); } };
    const orch = new LlmOrchestrator({ llm: brokenLlm, deps, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    const res = await orch.process('anything');
    expect(res.fallbackToDeterministic).toBe(true);
    expect(res.error).toContain('500');
  });
});

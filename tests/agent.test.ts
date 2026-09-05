import { describe, it, expect, vi } from 'vitest';
import { SupportVoiceAgent } from '../src/index';
import type { JiraChange, SpeechEvent, SupportVoiceAgentConfig } from '../src/index';
import type { RunbookAction, RunbookProvider, RunbookResult } from '../src/support-voice-agent/integrations/runbook';
import type { SlackNotifier } from '../src/support-voice-agent/integrations/slack';
import type { JiraConfig } from '../src/support-voice-agent/integrations/jira';
import { renderMeetingSummary } from '../src/support-voice-agent/summary';

/** Drain all pending microtask chains (mocked fetches resolve on microtasks,
 *  never timers), so async speech/jira assertions are deterministic. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('SupportVoiceAgent default wiring', () => {
  it('starts in silent mode and produces no speech by default', () => {
    const agent = makeAgent({ mode: 'silent' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'hey agent');
    expect(speech).toHaveLength(0);
  });

  it('silent mode ignores a vague complaint without speaking', () => {
    const agent = makeAgent({ mode: 'silent' });
    const log: { level: string; message: string }[] = [];
    agent.on('log', (e: { level: string; message: string }) => log.push(e));

    agent.processUtterance('U1', "it's down");
    expect(log.some((e) => e.level === 'info' && e.message.includes('Silent mode: complaint noted'))).toBe(true);
  });

  it('silent mode notes feedback without speaking', () => {
    const agent = makeAgent({ mode: 'silent' });
    const log: { level: string; message: string }[] = [];
    agent.on('log', (e: { level: string; message: string }) => log.push(e));

    agent.processUtterance('U1', 'Users hate the new UI');
    expect(log.some((e) => e.level === 'info' && e.message.includes('feedback noted'))).toBe(true);
  });

  it('group questions in silent mode produce no speech', () => {
    const agent = makeAgent({ mode: 'silent' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'what is the status of checkout?');
    expect(speech).toHaveLength(0);
  });
});

describe('SupportVoiceAgent response mode', () => {
  it('responds to a bare wake word with a greeting', async () => {
    const agent = makeAgent({ mode: 'response' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'hey agent');
    expect(speech).toHaveLength(0);
    agent.onPause(2000);
    await flush();
    expect(speech).toHaveLength(1);
    expect(speech[0]?.text).toContain("I'm here");
  });

  it('paraphrases feedback and asks about filing a bug', async () => {
    const agent = makeAgent({ mode: 'response' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'Users hate the new UI');
    agent.onPause(2000);
    await flush();

    expect(speech.length).toBeGreaterThanOrEqual(1);
    const line = speech[speech.length - 1]?.text.toLowerCase();
    expect(line).toContain('users hate the new ui');
    expect(line).toContain('jira bug');
  });

  it('asks for specifics when a vague technical complaint is heard', async () => {
    const agent = makeAgent({ mode: 'response' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'the api is down');
    agent.onPause(2000);
    await flush();

    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain('what error');
  });

  it('interrupts immediately on a P1 declaration', () => {
    const agent = makeAgent({ mode: 'silent' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'This is a P1');

    expect(speech.length).toBeGreaterThanOrEqual(1);
    const first = speech[0];
    expect(first).toBeDefined();
    expect(first!.text.toLowerCase()).toContain('urgent alert');
    expect(first!.text.toLowerCase()).toContain('p1');
    expect(first!.urgent).toBe(true);
  });

  it('does not barge in on a non-critical statement', () => {
    const agent = makeAgent({ mode: 'silent' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'there is a p2 defect');
    expect(speech).toHaveLength(0);
  });

  it('stays silent during an architecture deep-dive', () => {
    const agent = makeAgent({ mode: 'response' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    const arch = [
      'we should refactor the schema',
      'what about the service boundary',
      'event-driven would be cleaner',
      'and the contract',
    ];
    for (const line of arch) agent.processUtterance('U1', line);
    agent.onPause(2000);

    expect(speech).toHaveLength(0);
  });

  it('mutes for 5 minutes on "Agent, shut up"', () => {
    const now = 1_000_000;
    const agent = makeAgent({ mode: 'response', now: () => now });
    const muted: { until: number }[] = [];
    agent.on('muted', (e: { until: number }) => muted.push(e));

    agent.processUtterance('U1', 'Agent, shut up');

    expect(muted.length).toBe(1);
    expect(muted[0]?.until).toBe(now + 5 * 60_000);
  });

  it('remains muted after "Agent, shut up" until the pause ends', async () => {
    const now = 1_000_000;
    const agent = makeAgent({ mode: 'response', now: () => now });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'Agent, shut up');
    agent.processUtterance('U2', 'hey agent, what is the status');
    agent.onPause(2000);
    await flush();

    // After "Agent, shut up" the mute window suppresses queued speech.
    // Only a *bare* wake word responds during the mute window; a wake word
    // wrapped around a question re-arms the agent without answering the
    // muted utterance itself.
    expect(speech.some((e) => !e.urgent)).toBe(false);
  });

  it('unmutes on a wake word', async () => {
    const now = 1_000_000;
    const agent = makeAgent({ mode: 'response', now: () => now });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'Agent, shut up');
    agent.processUtterance('U2', 'hey agent');
    agent.onPause(2000);
    await flush();

    expect(speech.length).toBeGreaterThanOrEqual(1);
    expect(speech[0]?.text).toContain("I'm here");
  });

  it('does not process a vague complaint while muted', () => {
    const agent = makeAgent({ mode: 'response' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'Agent, shut up');
    agent.processUtterance('U2', 'the api is down');
    agent.onPause(2000);

    expect(speech.length).toBe(0);
  });
});

describe('SupportVoiceAgent feedback flow', () => {
  it('confirms a Jira bug when told "yes, high priority"', async () => {
    const agent = makeAgent({ mode: 'response', jira: makeJira() });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));
    const jiraChanges: JiraChange[] = [];
    agent.on('jira', (e: JiraChange) => jiraChanges.push(e));

    agent.processUtterance('U1', 'Users hate the new UI');
    agent.onPause(2000);
    await flush();

    const offer = speech[speech.length - 1];
    expect(offer).toBeDefined();
    expect(offer!.text.toLowerCase()).toContain('jira bug');
    expect(offer!.text.toLowerCase()).toContain('priority');

    agent.processUtterance('U2', 'yes, high priority');
    agent.onPause(2000);
    await flush();

    expect(jiraChanges.some((c) => c.type === 'created')).toBe(true);
  });

  it('declines to file a bug on negation', async () => {
    const agent = makeAgent({ mode: 'response', jira: makeJira() });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));
    const jiraChanges: JiraChange[] = [];
    agent.on('jira', (e: JiraChange) => jiraChanges.push(e));

    agent.processUtterance('U1', 'Users hate the new UI');
    agent.onPause(2000);
    await flush();
    agent.processUtterance('U2', 'no, never mind');
    agent.onPause(2000);
    await flush();

    expect(jiraChanges.filter((c) => c.type === 'created')).toHaveLength(0);
    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain("won't file");
  });

  it('stays honest about a bug offer when Jira is unwired', async () => {
    const agent = makeAgent({ mode: 'response' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));
    const jiraChanges: JiraChange[] = [];
    agent.on('jira', (e: JiraChange) => jiraChanges.push(e));

    agent.processUtterance('U1', 'Users hate the new UI');
    agent.onPause(2000);
    await flush();
    agent.processUtterance('U2', 'yes, high priority');
    agent.onPause(2000);
    await flush();

    // No Jira wired => no HTTP attempted, no change claimed; it says so.
    expect(jiraChanges).toHaveLength(0);
    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain("not connected to jira");
    // The feedback is kept for the end-of-meeting summary.
    expect(agent.finishMeeting().feedback.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SupportVoiceAgent direct-question handling', () => {
  it('answers a ticket-status question if Jira is wired, with pause gating', async () => {
    const jira = makeJira();
    // Use the test's own fetch so we don't hit the network.
    const fakeFetch = vi.fn((url: string) => {
      if (url.includes('/rest/api/3/issue/SUPPORT-1?fields=summary,status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ key: 'SUPPORT-1', fields: { summary: 'Fake', status: { name: 'To Do' } } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('null', { status: 404 }));
    }) as unknown as typeof fetch;
    const agent = makeAgent({ mode: 'response', jira: { ...jira, request: fakeFetch } });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'what is the status of SUPPORT-1?');
    agent.onPause(2000);
    await flush();

    const statuses = speech.filter((s) => s.text.toLocaleLowerCase().includes('currently'));
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses[0]?.text).toContain("'To Do'");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the honest unwired answer when Jira is not configured', async () => {
    const agent = makeAgent({ mode: 'response' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'what is the status of TICKET-1');
    agent.onPause(2000);
    await flush();

    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text).toBe("I don't have that data in my current context, but I can pull it from Jira now.");
  });

  it('quotes the exact formatJiraUpdate string for a comment append', async () => {
    const jira = makeJira();
    let captured: string | undefined;
    const fakeFetch = vi.fn((_url: string, opts: RequestInit) => {
      if (opts.body) captured = JSON.parse(opts.body as string).body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    const agent = makeAgent({ mode: 'response', jira: { ...jira, request: fakeFetch } });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    await agent.commentOnTicket('SUPPORT-1', 'testing');
    agent.onPause(2000);
    await flush();

    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain("added a comment to support-1");
    expect(captured).toBe('testing');
  });

  it('refuses to update ticket status when Jira is unwired', async () => {
    const agent = makeAgent({ mode: 'response' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    await agent.updateTicketStatus('TICKET-1', 'In Progress');
    agent.onPause(2000);
    await flush();

    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain("not connected");
  });
});

describe('SupportVoiceAgent runbook flow', () => {
  it('offers a non-destructive runbook action when asked', async () => {
    const runbooks = makeRunbooks({ 'restart-checkout-pod': { ok: true, output: 'done' } });
    const agent = makeAgent({ mode: 'response', runbooks });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    await agent.offerRunbookAction('restart-checkout-pod');
    agent.onPause(2000);
    await flush();

    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain('should i restart the checkout pod');
  });

  it('offers no speech when the action id does not exist', async () => {
    const agent = makeAgent({ mode: 'response', runbooks: makeRunbooks() });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    await agent.offerRunbookAction('nothing-here');
    agent.onPause(2000);
    await flush();

    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain("couldn't find");
  });

  it('executes the runbook when the human confirms the offer', async () => {
    const runbooks = makeRunbooks({ 'restart-checkout-pod': { ok: true, output: 'pod restarted ok' } });
    const agent = makeAgent({ mode: 'response', runbooks });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    await agent.offerRunbookAction('restart-checkout-pod');
    agent.onPause(2000);
    await flush();
    agent.processUtterance('U2', 'yes');
    agent.onPause(2000);
    await flush();

    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain('pod restarted ok');
  });

  it('does not execute the runbook when the human declines', async () => {
    let executed = false;
    const runbooks: RunbookProvider = {
      list: async () => [
        { id: 'restart-checkout-pod', name: 'Restart checkout pod', description: 'restart the checkout pod', destructive: false } as RunbookAction,
      ],
      run: async (_id: string) => {
        executed = true;
        return { actionId: _id, ok: false } as RunbookResult;
      },
    };
    const agent = makeAgent({ mode: 'response', runbooks });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    await agent.offerRunbookAction('restart-checkout-pod');
    agent.onPause(2000);
    await flush();
    agent.processUtterance('U2', 'no');
    agent.onPause(2000);
    await flush();

    expect(executed).toBe(false);
    const last = speech[speech.length - 1];
    expect(last).toBeDefined();
    expect(last!.text.toLowerCase()).toContain("won't touch anything");
  });

  it('drops a runbook offer once the confirm window has expired', async () => {
    let now = 1_000_000;
    let executed = false;
    const runbooks: RunbookProvider = {
      list: () => [{ id: 'restart-checkout-pod', name: 'Restart checkout pod', description: 'restart the checkout pod', destructive: false }],
      run: async (actionId: string) => {
        executed = true;
        return { actionId, ok: true } as RunbookResult;
      },
    };
    const agent = makeAgent({ mode: 'response', runbooks, now: () => now });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    await agent.offerRunbookAction('restart-checkout-pod');
    agent.onPause(2000);
    await flush();

    now += 61_000; // past the 60 s confirm window
    agent.processUtterance('U2', 'yes', now);
    agent.onPause(2000);
    await flush();

    expect(executed).toBe(false);
  });
});

describe('SupportVoiceAgent meeting summaries', () => {
  it('emits a summary with all captured items', () => {
    const agent = makeAgent({ now: () => 1_000 });

    agent.processUtterance('U1', 'Users hate the new UI');
    agent.processUtterance('U2', 'the api is down');
    agent.ingestAlert({ severity: 'P1', source: 'cloudwatch', summary: 'high error rate', ts: 1_000 });

    const data = agent.finishMeeting({ meetingId: 'm1', title: 'Standup' });
    expect(data.meetingId).toBe('m1');
    expect(data.title).toBe('Standup');
    expect(data.feedback.length).toBeGreaterThanOrEqual(1);
    expect(data.concerns.length).toBeGreaterThanOrEqual(1);
    expect(data.alerts.length).toBeGreaterThanOrEqual(1);
    expect(data.participants).toContain('U1');
    expect(data.participants).toContain('U2');
  });

  it('posts meeting summary via the provided slack notifier', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const slack = { postMessage } as unknown as SlackNotifier;
    const agent = makeAgent({ slack });
    agent.processUtterance('U1', 'hello');

    const data = await agent.postMeetingSummary({ type: 'slack', channel: '#incidents' });
    expect(data).toBeInstanceOf(Object);
    expect(postMessage).toHaveBeenCalledTimes(1);
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('posts meeting summary via the provided Jira client', async () => {
    const jira = makeJira();
    const http = vi.fn((url: string) => {
      if (url.includes('/rest/api/3/issue/SUPPORT-1/comment')) return Promise.resolve(new Response(null, { status: 204 }));
      if (url.includes('/rest/api/3/issue/SUPPORT-1?fields=summary,status')) return Promise.resolve(new Response(JSON.stringify({ key: 'SUPPORT-1', fields: { summary: 'x', status: { name: 'To Do' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return Promise.resolve(new Response('null', { status: 404 }));
    });
    const agent = makeAgent({ jira: { ...jira, request: http as unknown as typeof fetch } });
    agent.processUtterance('U1', 'hello');

    const data = await agent.postMeetingSummary({ type: 'jira', issueKey: 'SUPPORT-1' });
    expect(data).toBeInstanceOf(Object);
    // The injected fake fetch is the test's proof the comment POST happened once.
    expect(http).toHaveBeenCalledTimes(1);
    expect(String(http.mock.calls[0]?.[0])).toContain('/rest/api/3/issue/SUPPORT-1/comment');
    await flush();
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('renders summary text with the expected sections', () => {
    const agent = makeAgent({ now: () => 2_000 });
    agent.processUtterance('U1', 'Users hate the new UI');
    agent.processUtterance('U2', 'the api is down');
    const data = agent.finishMeeting({ meetingId: 'm2', title: 'Standup' });
    const text = renderMeetingSummary(data);
    expect(text).toContain('# Meeting Summary');
    expect(text).toContain('Standup');
    expect(text.toLowerCase()).toContain('users hate the new ui');
    expect(text.toLowerCase()).toContain('api is down');
  });
});

function makeAgent(cfg: Partial<SupportVoiceAgentConfig> = {}) {
  const now = cfg.now ?? Date.now;
  return new SupportVoiceAgent({
    mode: 'silent',
    wakeWord: 'hey agent',
    minPauseMs: 1500,
    maxResponseWords: 20,
    muteDurationMs: 5 * 60_000,
    urgentBreaksMute: true,
    runbookConfirmWindowMs: 60_000,
    autoFileFeedback: false,
    runbooks: makeRunbooks(),
    ...cfg,
    now,
  });
}

/** Jira config backed by an in-test fake server — never the network.
 *  Tests may override `request` via spread to assert on specific endpoints. */
function makeJira(): JiraConfig {
  const fakeServer: typeof fetch = (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/rest/api/3/issue') && !url.includes('/comment')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            key: 'SUPPORT-101',
            id: '10101',
            self: `${url}`,
            fields: { summary: 'Fake issue', status: { name: 'To Do' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (url.includes('/comment')) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(new Response('null', { status: 404 }));
  };
  return {
    baseUrl: 'https://jira.invalid.test',
    auth: { type: 'bearer', token: 'fake-token' },
    projectKey: 'SUPPORT',
    request: fakeServer,
  };
}

function makeRunbooks(overrides?: Record<string, Omit<RunbookResult, 'actionId'>>): RunbookProvider {
  const actions: RunbookAction[] = [
    { id: 'restart-checkout-pod', name: 'Restart checkout pod', description: 'restart the checkout pod', destructive: false },
    { id: 'restart-payment-pod', name: 'Restart payment pod', description: 'restart the payment pod', destructive: false },
    { id: 'restart-all', name: 'Restart all pods', description: 'restart all pods', destructive: true },
  ];
  const results = new Map<string, RunbookResult>(
    Object.entries(overrides ?? {}).map(([key, value]) => [key, { actionId: key, ...value } as RunbookResult]),
  );
  return {
    list: async () => actions,
    run: async (actionId: string) => {
      const hit = results.get(actionId);
      if (hit) return hit;
      return { actionId, ok: true, output: `${actions.find((a) => a.id === actionId)?.name ?? actionId} executed` };
    },
  } as unknown as RunbookProvider;
}

describe('SupportVoiceAgent LLM routing (Layer 2 glue)', () => {
  const scriptedLlm = (script: Array<{ content?: string; tool_calls?: unknown[]; error?: string }>) => {
    let n = 0;
    return {
      isWired: () => true,
      complete: async () => {
        const step = script[n++];
        if (!step) throw new Error('script exhausted');
        if (step.error) throw Object.assign(new Error(step.error), { code: 'http_error' });
        return {
          id: 'r',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: step.content, tool_calls: step.tool_calls },
            finish_reason: step.tool_calls ? 'tool_calls' : 'stop',
          }],
        };
      },
    };
  };

  it('routes a direct question through the orchestrator and speaks after the pause', async () => {
    const agent = makeAgent({
      mode: 'response',
      llm: scriptedLlm([{ content: 'Checkout is healthy at 99.9 percent uptime.' }]) as never,
    });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'what is the status of checkout?');
    await flush();
    expect(speech).toHaveLength(0); // still pause-gated
    agent.onPause(2000);
    await flush();
    expect(speech.some((e) => e.text.includes('99.9'))).toBe(true);
  });

  it('degrades to the deterministic answer when the LLM errors mid-flight', async () => {
    const agent = makeAgent({
      mode: 'response',
      llm: scriptedLlm([{ error: 'gateway 500' }]) as never,
    });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', "what's the status of SUPPORT-9?");
    await flush();
    agent.onPause(2000);
    await flush();
    // Deterministic unwired-Jira fallback per spec
    expect(speech.some((e) => e.text.includes("pull it from Jira"))).toBe(true);
  });

  it('wake word, mute and barge-in stay deterministic with an LLM wired', async () => {
    const agent = makeAgent({
      mode: 'response',
      llm: scriptedLlm([{ content: 'should not be used' }]) as never,
    });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', 'this is a P1');
    await flush();
    expect(speech.some((e) => e.urgent)).toBe(true); // barge-in without any LLM call

    agent.processUtterance('U1', 'hey agent, what is the status?');
    await flush();
    // wake-word + question with LLM wired routed once; not a greeting
    expect(speech.some((e) => e.text.includes("I'm here"))).toBe(false);
  });

  it('hasLlm reflects the injected client', () => {
    expect(makeAgent({}).hasLlm).toBe(false);
    expect(makeAgent({ llm: scriptedLlm([]) as never }).hasLlm).toBe(true);
  });
});

describe('Jira failover wording (spec: alert infra on API failure)', () => {
  it('speaks the failover line and pages infra when a ticket pull fails', async () => {
    const posted: Array<{ channel: string; text: string }> = [];
    const failingJira: JiraConfig = {
      baseUrl: 'https://jira.test',
      auth: { type: 'bearer', token: 'test-key' },
      projectKey: 'SUPPORT',
      request: (() => Promise.resolve(new Response(JSON.stringify({ errorMessages: ['boom'] }), { status: 503 }))) as unknown as typeof fetch,
    };
    const agent = makeAgent({
      mode: 'response',
      jira: failingJira,
      slack: { postMessage: async (channel, text) => { posted.push({ channel, text }); } },
      guardrails: { infraChannel: '#infra' },
    });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e: SpeechEvent) => speech.push(e));

    agent.processUtterance('U1', "what's the status of SUPPORT-9?");
    await flush();
    agent.onPause(2000);
    await flush();
    expect(speech.some((e) => e.text.includes('Jira is inaccessible') && e.text.includes('alerted the infrastructure team'))).toBe(true);
    expect(posted.some((m) => m.channel === '#infra' && m.text.includes('failover'))).toBe(true);
  });
});

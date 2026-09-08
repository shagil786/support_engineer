import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createPlatform } from '../../src/bootstrap';
import { LearningLoop } from '../../src/learning/learning-loop';
import { OrchestratedPipeline } from '../../src/pipeline/agent-pipeline';
import { JsonlFileEventLog } from '../../src/event-log/log';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const successfulOutcome = (cid: string): string =>
  JSON.stringify({
    correlationId: 'seed-' + cid,
    ts: 1,
    toolCalls: [
      { kind: 'tool_call', tool: 'query_logs', args: { query_string: 'x' }, result: { ok: true, data: {} }, latencyMs: 1, attempts: 1 },
      { kind: 'tool_call', tool: 'jira_create_issue', args: { summary: 'x', issue_type: 'Bug' }, result: { ok: true, data: {} }, latencyMs: 1, attempts: 1 },
    ],
    approvals: [],
  });

const logProvider = {
  name: 'fake',
  query: async () => ({ provider: 'splunk', rows: [], error: undefined }),
};

const runbooks = [
  { id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true },
  { id: 'clear-cache', name: 'clear-cache', description: 'clear the api cache', destructive: false },
];

describe('createPlatform', () => {
  it('wires the full pipeline with an empty env (learning off, durable library present)', () => {
    const p = createPlatform({ dataDir: dir });
    expect(p.pipeline).toBeInstanceOf(OrchestratedPipeline);
    expect(p.eventLog).toBeDefined();
    expect(p.learningLoop).toBeUndefined();
    // The library is always wired: "serve what was learned, stop learning."
    expect(p.library).toBeDefined();
    // The knowledge base is always present and retrieval is live in the
    // assembler: ingest a doc, then retrieve it through the platform.
    expect(p.knowledge).toBeDefined();
  });

  it('knowledge base: ingest → provenance-tagged retrieval through the pipeline assembler', async () => {
    const p = createPlatform({ dataDir: dir, runbooks });
    await p.knowledge.ingest({
      id: 'run-cache-clear',
      text: '# Clear the API cache',
      metadata: { source: 'runbooks', tags: ['cache'] },
    });
    const hits = await p.knowledge.search('api cache clear');
    expect(hits[0]?.docId).toBe('run-cache-clear');
    expect(hits[0]?.metadata?.['source']).toBe('runbooks');
    expect(hits[0]?.heading).toBe('Clear the API cache');
  });

  it('learning on: the scheduled loop actually STARTS (interval fires; stopLearning stops it)', async () => {
    vi.useFakeTimers();
    try {
      const p = createPlatform({ dataDir: dir, learning: { enabled: true, intervalMs: 1000 } });
      expect(p.learningLoop).toBeInstanceOf(LearningLoop);
      // Regression: bootstrap constructed the loop but never called start(),
      // so "learning: on, every Nms" was a lie — the interval never fired.
      const tickSpy = vi.spyOn(p.learningLoop!, 'tick');
      await vi.advanceTimersByTimeAsync(2500);
      expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      p.stopLearning();
      const after = tickSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(tickSpy.mock.calls.length).toBe(after); // stopped means stopped
    } finally {
      vi.useRealTimers();
    }
  });

  it('learning off: no loop, no timer (stopLearning is a safe no-op)', async () => {
    const p = createPlatform({ dataDir: dir });
    expect(p.learningLoop).toBeUndefined();
    expect(() => p.stopLearning()).not.toThrow();
  });

  it('learning on: durable library wired into the supervisor; tick then short-circuit live request', async () => {
    const p = createPlatform({
      dataDir: dir,
      learning: { enabled: true },
      logProvider,
      runbooks,
    });
    expect(p.learningLoop).toBeInstanceOf(LearningLoop);
    expect(p.library).toBeDefined();
    // Snapshot is created lazily, not at construction.
    expect(existsSync(join(dir, 'memory', 'procedures.json'))).toBe(false);

    // Seed outcomes, run one learning tick, then serve a live utterance.
    mkdirSync(join(dir, 'outcomes'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, 'outcomes', 'o' + String(i) + '.json'), successfulOutcome(String(i)));
    }
    await p.learningLoop!.tick();
    await p.library!.refresh();
    expect(p.library!.size()).toBe(1);

    const r = await p.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(true);

    let outcome;
    for await (const e of (p.eventLog as JsonlFileEventLog).query({ correlationId: r.correlationId })) {
      if (e.kind === 'agent_outcome') outcome = e;
    }
    expect(outcome?.finalResult.summary).toContain('via:procedure');
  });

  it('records pipeline-routed utterances as durable per-meeting memories', async () => {
    const p = await createPlatform({ dataDir: dir });
    const r = await p.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    const meetingsFile = join(dir, 'memory', 'meetings.json');
    expect(existsSync(meetingsFile)).toBe(true);
    const store = JSON.parse(readFileSync(meetingsFile, 'utf8')) as unknown;
    const s = JSON.stringify(store);
    expect(s).toContain('agent, can you check the error logs for the api?');
    expect(s).toContain('meeting:u1');
  });

  it('wires LLM completions into the event spine as llm_call events', async () => {
    const fakeRequest = (async () =>
      Response.json({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      })) as unknown as typeof fetch;
    const p = createPlatform({
      dataDir: dir,
      llm: { baseUrl: 'http://fake', apiKey: 'k', model: 'fake-model', request: fakeRequest },
    });
    await p.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    await new Promise((r) => setTimeout(r, 200)); // the onCall hook is fire-and-forget
    let llmCall;
    for await (const e of (p.eventLog as JsonlFileEventLog).query({})) {
      if (e.kind === 'llm_call') llmCall = e;
    }
    expect(llmCall).toBeDefined();
    expect(llmCall?.model).toBe('fake-model');
    expect(llmCall?.ok).toBe(true);
    expect(llmCall?.attempts).toBe(1);
    expect(llmCall?.promptTokens).toBe(12);
  });

  it('supervisorCaps flow through to the supervisor (maxHops=1 fails the dance fast)', async () => {
    const p = createPlatform({ dataDir: dir, logProvider, runbooks, supervisorCaps: { maxHops: 1 } });
    const r = await p.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hop cap/);
  });

  it('ready() sweeps approvals orphaned by a previous process and reports the count', async () => {
    // Process 1: stage a destructive request, never terminate it.
    const p1 = createPlatform({ dataDir: dir, runbooks, speakerRole: (id) => (id === 'admin1' ? 'admin' : undefined) });
    const r1 = await p1.pipeline.processUtterance('admin1', 'agent, can you restart the checkout pod?');
    expect(r1.approvalId).toBeTruthy();
    await p1.stopLearning();
    // The staged request is a fire-and-forget audit write; wait for it to
    // hit disk before the successor process reconciles over the log.
    await new Promise((r) => setTimeout(r, 20));
    const stagedKinds: string[] = [];
    for await (const e of p1.eventLog.query({ correlationId: r1.approvalId! })) stagedKinds.push(e.kind);
    expect(stagedKinds).toContain('approval_request');

    // Process 2: same data dir. The pending approval died with process 1.
    const p2 = createPlatform({ dataDir: dir, runbooks, speakerRole: (id) => (id === 'admin1' ? 'admin' : undefined) });
    const ready = await p2.ready();
    expect((ready as { approvalsSwept?: number }).approvalsSwept).toBe(1);

    // The spine now carries a terminal event for the orphaned request.
    const kinds: string[] = [];
    for await (const e of p2.eventLog.query({ correlationId: r1.approvalId! })) kinds.push(e.kind);
    expect(kinds).toContain('approval_request');
    expect(kinds).toContain('approval_timeout');
    // Idempotent: ready() again sweeps nothing new.
    expect(await p2.ready()).not.toHaveProperty('approvalsSwept');
    await p2.stopLearning();
  });

  it('ready() resolves after boot async work and reports kb/procedure/learning state', async () => {
    const p = createPlatform({ dataDir: dir, learning: { enabled: true }, logProvider, runbooks });
    const r = await p.ready();
    expect(r.learning).toBe('on');
    expect(r.procedures).toBe(0);
    expect(r.kb.docs).toBeGreaterThanOrEqual(0);
  });

  it('two security layers: guests are vetoed by the SafetyNet; approvers stage for approval', async () => {
    const p = createPlatform({
      dataDir: dir,
      logProvider,
      runbooks,
      speakerRole: (id) => (id === 'admin1' ? 'admin' : undefined),
    });
    // Unknown speaker = guest → the always-on SafetyNet vetoes destructive
    // tools outright (no approval path exists for guests).
    const guest = await p.pipeline.processUtterance('u1', 'agent, can you restart the checkout pod?', 500);
    expect(guest.routed).toBe('pipeline');
    expect(guest.ok).toBe(false);
    expect(guest.reason).toMatch(/veto/i);
    // An approver's identical offer stages for M-of-N approval.
    const admin = await p.pipeline.processUtterance('admin1', 'agent, can you restart the checkout pod?', 600);
    expect(admin.routed).toBe('pipeline');
    expect(admin.approvalId).toBeDefined();
    expect(admin.approvalStatus).toBe('pending');
  });

  it('exposes the ApprovalGate and the server-side role resolver (reaction UX surface)', async () => {
    const p = createPlatform({
      dataDir: dir,
      speakerRole: (id) => (id === 'U-alice' ? 'admin' : undefined),
    });
    expect(p.approvals).toBeDefined();
    // The resolver is server-side: guests by default, host mappings apply,
    // and the gate-minted approver identity is always admin.
    expect(p.speakerRole('U-alice')).toBe('admin');
    expect(p.speakerRole('U-stranger')).toBeUndefined();
    expect(p.speakerRole('approver')).toBe('admin');

    // Emoji sign-off through the exposed gate (single-pending fallback).
    const { approvalId } = await p.approvals.request({
      policyId: 'p1',
      decision: { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] },
      action: { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } },
    });
    const r = await p.approvals.handleReaction({ type: 'reaction_added', reaction: 'shield', userId: 'U-alice', userRole: p.speakerRole('U-alice') });
    expect(r).toMatchObject({ matched: true, approvalId, accepted: true });
  });

  it('routes the approval gate through slackBotRequest — a local fake Slack Web API without process-wide patching', async () => {
    // Stand-in Slack Web API on an ephemeral port: records every method
    // called and returns ref-bearing ok responses like the real one.
    const apiCalls: string[] = [];
    const fakeSlack = http.createServer((req, res) => {
      const method = req.url?.replace('/api/', '') ?? '';
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        apiCalls.push(method);
        const body = JSON.parse(raw || '{}') as { channel?: string };
        res.end(JSON.stringify({ ok: true, channel: body.channel ?? 'C-approvals', ts: '1700000000.000100' }));
      });
    });
    await new Promise<void>((resolve) => fakeSlack.listen(0, '127.0.0.1', resolve));
    const addr = fakeSlack.address() as { port: number };

    try {
      const p = createPlatform({
        dataDir: dir,
        runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true }],
        speakerRole: (id) => (id === 'U-admin' ? 'admin' : undefined),
        slackBotToken: 'xoxb-fake-test',
        slackBotRequest: ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith('https://slack.com/api/')) {
            return fetch(url.replace('https://slack.com/api', `http://127.0.0.1:${addr.port}/api`));
          }
          return fetch(input, init);
        }) as typeof fetch,
      });

      // A destructive request stages through the REAL gate, whose Slack is
      // the real SlackBotClient — pointed at the fake by the new option.
      const staged = await p.pipeline.processUtterance('U-admin', 'agent, can you restart the checkout pod?', 500);
      expect(staged.approvalId).toBeDefined();
      expect(apiCalls).toContain('chat.postMessage');
      const grants = apiCalls.filter((m) => m === 'chat.postMessage').length;
      expect(grants).toBeGreaterThanOrEqual(1);
    } finally {
      fakeSlack.close();
    }
  });
});

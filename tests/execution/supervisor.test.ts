import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SupervisorAgent } from '../../src/execution/supervisor';
import { ToolRunner } from '../../src/execution/tool-runner';
import { TriageAgent } from '../../src/execution/agents/triage';
import { InvestigatorAgent } from '../../src/execution/agents/investigator';
import { ExecutorAgent } from '../../src/execution/agents/executor';
import { ReviewerAgent } from '../../src/execution/agents/reviewer';
import { OpenAiCompatibleClient } from '../../src/support-voice-agent/tools/llm';
import { SafetyNet } from '../../src/governance/safety-net';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextBundle } from '../../src/understanding/context-assembler';
import type { GovernedAction, Decision } from '../../src/governance/decision';
import type { ToolName } from '../../src/support-voice-agent/tools/types';

// Unwired LLM → every agent takes its deterministic fallback path.
const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });

const allowDecision: Decision = { effect: 'allow', reason: 't', policyIds: [] };

const bundle: ContextBundle = {
  envelope: {
    intent: { kind: 'unknown' },
    confidence: 0,
    entities: {},
    rawContext: { source: 'meeting', ts: 1, payload: {} },
  },
  episodes: [],
  recent: [],
};

const governedExecute = (tool: ToolName, args: Record<string, unknown>): GovernedAction => ({
  kind: 'execute',
  decision: allowDecision,
  action: { tool, args },
});

const ctx = (correlationId: string) => ({
  correlationId,
  speakerId: 'u1',
  tokens: { prompt: 0, completion: 0 },
  candidateOutput: '',
  toolCallHistory: [] as Array<{ tool: ToolName; args: unknown }>,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'supervisor-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSupervisor(over: Partial<ConstructorParameters<typeof SupervisorAgent>[0]> = {}) {
  return new SupervisorAgent({
    triage: new TriageAgent({ llm }),
    investigator: new InvestigatorAgent({ llm }),
    executor: new ExecutorAgent({ llm }),
    reviewer: new ReviewerAgent({ llm }),
    toolRunner: new ToolRunner({ context: {} }),
    ...over,
  });
}

describe('SupervisorAgent', () => {
  it('shows the live tool-call trace to the reviewer (a bundle built pre-dance must not blind the final review)', async () => {
    const seen: string[][] = [];
    const spyLlm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    (spyLlm as unknown as { isWired: () => boolean }).isWired = () => true;
    (spyLlm as unknown as { complete: unknown }).complete = async (input: { messages: Array<{ role: string; content: string }> }) => {
      const parsed = JSON.parse(input.messages[1].content) as { recent: Array<{ kind: string }> };
      seen.push(parsed.recent.map((e) => e.kind));
      return { choices: [{ message: { content: JSON.stringify({ verdict: 'pass', feedback: 'trace seen' }) } }] };
    };
    const eventLog = new JsonlFileEventLog({ baseDir: dir });
    const sup = makeSupervisor({
      eventLog,
      reviewer: new ReviewerAgent({ llm: spyLlm }),
      toolRunner: new ToolRunner({
        eventLog,
        context: { logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: undefined }) } },
      }),
    });
    const r = await sup.run({ governed: governedExecute('query_logs', { query_string: 'errors' }), context: ctx('c-trace'), bundle });
    expect(r.ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const finalView = seen[seen.length - 1] ?? [];
    expect(finalView).toContain('tool_call');
  });

  it('runs the pipeline end-to-end for a read-only query', async () => {
    const sup = makeSupervisor({
      toolRunner: new ToolRunner({
        context: { logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: undefined }) } },
      }),
    });
    const r = await sup.run({ governed: governedExecute('query_logs', { query_string: 'errors' }), context: ctx('c1'), bundle });
    expect(r.ok).toBe(true);
    expect(r.hops).toBeGreaterThanOrEqual(1);
    expect(r.toolCalls).toBe(1);
  });

  it('executes the governed action through the ToolRunner', async () => {
    let created = 0;
    const sup = makeSupervisor({
      toolRunner: new ToolRunner({
        context: { jiraClient: { createIssue: async () => { created++; return { key: 'SUPPORT-2', id: '2' }; } } },
      }),
    });
    const r = await sup.run({
      governed: governedExecute('jira_create_issue', { summary: 'checkout 502s', issue_type: 'Bug' }),
      context: ctx('c2'),
      bundle,
    });
    expect(r.ok).toBe(true);
    expect(created).toBe(1);
    expect(r.toolCalls).toBe(1);
  });

  it('emits agent_outcome to the event log when wired', async () => {
    const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
    const sup = makeSupervisor({ toolRunner: new ToolRunner({ context: {}, eventLog: log }), eventLog: log });
    await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('c3'), bundle });
    const kinds: string[] = [];
    for await (const e of log.query({ correlationId: 'c3' })) kinds.push(e.kind);
    expect(kinds).toContain('agent_outcome');
  });

  it('refuses to run an unresolved approval', async () => {
    const sup = makeSupervisor();
    const r = await sup.run({
      governed: { kind: 'request_approval', decision: allowDecision, action: { tool: 'execute_runbook_script', args: {} }, approvalId: 'a1' },
      context: ctx('c4'),
      bundle,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/approval/);
  });

  it('skips side-effects for a denied action', async () => {
    let created = 0;
    const sup = makeSupervisor({
      toolRunner: new ToolRunner({
        context: { jiraClient: { createIssue: async () => { created++; return { key: 'X', id: '1' }; } } },
      }),
    });
    const r = await sup.run({
      governed: { kind: 'deny', decision: { effect: 'deny', reason: 'PII guard', policyIds: ['p'] } },
      context: ctx('c5'),
      bundle,
    });
    expect(r.ok).toBe(false);
    expect(created).toBe(0);
  });

  it('honors the hop cap', async () => {
    const sup = makeSupervisor({ maxHops: 1 });
    const r = await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('c6'), bundle });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hop cap/);
  });

  it('honors the wall-clock cap', async () => {
    const sup = makeSupervisor({ maxWallClockMs: 0 });
    const r = await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('c7'), bundle });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/wall clock|hop cap/);
  });

  it('surfaces SafetyNet vetoes from the runner as failures', async () => {
    const sup = makeSupervisor({
      toolRunner: new ToolRunner({
        context: { runbookProvider: { list: async () => [], run: async () => ({ ok: true as const, actionId: 'a', output: '' }) } },
        safetyNet: new SafetyNet({ speakers: () => 'guest' }),
      }),
    });
    const r = await sup.run({
      governed: governedExecute('execute_runbook_script', { script_name: 'restart-all' }),
      context: { ...ctx('c9'), speakerId: 'guest1' },
      bundle,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/veto/i);
  });
});

import { describe, it, expect } from 'vitest';
import { SupervisorAgent } from '../../src/execution/supervisor';
import { ProcedureLibrary } from '../../src/execution/procedure-library';
import { ToolRunner } from '../../src/execution/tool-runner';
import { TriageAgent } from '../../src/execution/agents/triage';
import { InvestigatorAgent } from '../../src/execution/agents/investigator';
import { ExecutorAgent } from '../../src/execution/agents/executor';
import { ReviewerAgent } from '../../src/execution/agents/reviewer';
import { OpenAiCompatibleClient } from '../../src/support-voice-agent/tools/llm';
import { EpisodicMemory } from '../../src/understanding/memory/episodic';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextBundle } from '../../src/understanding/context-assembler';
import type { GovernedAction } from '../../src/governance/decision';
import type { ProcedureSpec } from '../../src/learning/knowledge-extractor';
import type { ToolName } from '../../src/support-voice-agent/tools/types';

// Unwired LLM → agents take their deterministic fallback path.
const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
const allowDecision = { effect: 'allow' as const, reason: 't', policyIds: [] };
const bundle: ContextBundle = {
  envelope: { intent: { kind: 'unknown' }, confidence: 0, entities: {}, rawContext: { source: 'meeting', ts: 1, payload: {} } },
  episodes: [],
  recent: [],
};
const governedExecute = (tool: ToolName, args: Record<string, unknown>): GovernedAction => ({
  kind: 'execute', decision: allowDecision, action: { tool, args },
});
const ctx = (correlationId: string) => ({
  correlationId,
  speakerId: 'u1',
  tokens: { prompt: 0, completion: 0 },
  candidateOutput: '',
  toolCallHistory: [] as Array<{ tool: ToolName; args: unknown }>,
});

const procedure: ProcedureSpec = {
  id: 'proc-query-logs-jira-create-issue',
  trigger: 'query_logs → jira_create_issue',
  steps: [
    { agent: 'investigator', tool: 'query_logs', args: { query_string: 'stale historical query' } },
    { agent: 'investigator', tool: 'jira_create_issue', args: { summary: 'HISTORICAL ARGS MUST NOT RUN' } },
  ],
  successRate: 1,
  sampleSize: 4,
};

async function libraryWith(...specs: ProcedureSpec[]): Promise<ProcedureLibrary> {
  const episodic = new EpisodicMemory({});
  for (const s of specs) {
    await episodic.record('cross', { id: s.id, text: `procedure: ${s.trigger}`, metadata: { procedure: s } });
  }
  const lib = new ProcedureLibrary({ episodic });
  await lib.refresh();
  return lib;
}

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

describe('SupervisorAgent procedure short-circuit', () => {
  it('replays a learned procedure instead of the multi-agent dance', async () => {
    const seen: Array<{ tool: ToolName; args: Record<string, unknown> }> = [];
    const sup = makeSupervisor({
      procedures: await libraryWith(procedure),
      toolRunner: new ToolRunner({
        context: {
          logProvider: {
            name: 'fake',
            query: async (q: { query: string }) => {
              seen.push({ tool: 'query_logs', args: q as unknown as Record<string, unknown> });
              return { provider: 'splunk', rows: [], error: undefined };
            },
          },
        },
      }),
    });
    const r = await sup.run({
      governed: governedExecute('query_logs', { query_string: 'SUPPORT-7' }),
      context: ctx('p1'),
      bundle,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('procedure');
    expect(r.hops).toBe(0);
    // Exactly the procedure's follow-on steps ran — triage/investigator/
    // reviewer/executor agents never ran (fallback planner would add nothing,
    // but hops would be 4+ if the dance ran).
    expect(seen).toHaveLength(1);
  });

  it('replays the governed action with CURRENT approved args, never historical ones', async () => {
    let receivedQuery = '';
    const sup = makeSupervisor({
      procedures: await libraryWith(procedure),
      toolRunner: new ToolRunner({
        context: {
          logProvider: {
            name: 'fake',
            query: async (q: { query: string }) => {
              receivedQuery = q.query;
              return { provider: 'splunk', rows: [], error: undefined };
            },
          },
        },
      }),
    });
    await sup.run({ governed: governedExecute('query_logs', { query_string: 'SUPPORT-7' }), context: ctx('p2'), bundle });
    expect(receivedQuery).toBe('SUPPORT-7');
  });

  it('skips mutating follow-on steps and read-only steps verify fine', async () => {
    // jira_create_issue in the procedure must NOT run; a mutating step can
    // only replay through the current request's approved decision. Here the
    // request itself is the read-only query_logs, so replay = [logs] only.
    let created = 0;
    const sup = makeSupervisor({
      procedures: await libraryWith(procedure),
      toolRunner: new ToolRunner({
        context: {
          logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: undefined }) },
          jiraClient: { createIssue: async () => { created++; return { key: 'X', id: '1' }; } },
        },
      }),
    });
    const r = await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('p3'), bundle });
    expect(r.ok).toBe(true);
    expect(created).toBe(0);
  });

  it('mutating leading actions short-circuit with replay limited to read-only follow-ons', async () => {
    // Request: jira_create_issue (the mutation) — the procedure's follow-on
    // is the mutation step, which must be SKIPPED; replay = [logs] only.
    const followOn: ProcedureSpec = {
      ...procedure,
      id: 'proc-jira-first',
      trigger: 'jira_create_issue → query_logs',
      steps: [
        { agent: 'investigator', tool: 'jira_create_issue', args: { summary: 'hist' } },
        { agent: 'investigator', tool: 'query_logs', args: { query_string: 'hist' } },
      ],
    };
    let created = 0;
    const sup = makeSupervisor({
      procedures: await libraryWith(followOn),
      toolRunner: new ToolRunner({
        context: {
          logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: undefined }) },
          jiraClient: { createIssue: async () => { created++; return { key: 'SUPPORT-9', id: '9' }; } },
        },
      }),
    });
    const r = await sup.run({
      governed: governedExecute('jira_create_issue', { summary: 'checkout 502s', issue_type: 'Bug' }),
      context: ctx('p4'),
      bundle,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('procedure');
    expect(created).toBe(1); // only the governed action
  });

  it('falls back to the full agent dance when a replayed step fails verification', async () => {
    const sup = makeSupervisor({
      procedures: await libraryWith(procedure),
      toolRunner: new ToolRunner({
        context: { logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: 'boom' }) } },
      }),
    });
    const r = await sup.run({
      governed: governedExecute('query_logs', { query_string: 'x' }),
      context: ctx('p5'),
      bundle,
    });
    // The fallback dance ends with the governed action through the runner —
    // also an error result — so the request fails, but it must have FALLEN
    // BACK (source !== 'procedure').
    expect(r.ok).toBe(false);
    expect(r.source).toBe('pipeline');
  });

  it('falls back when the library has no matching procedure (hops prove the dance ran)', async () => {
    const sup = makeSupervisor({
      procedures: await libraryWith(),
      toolRunner: new ToolRunner({
        context: { logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: undefined }) } },
      }),
    });
    const r = await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('p6'), bundle });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('pipeline');
    expect(r.hops).toBeGreaterThanOrEqual(4);
  });

  it('marks procedure outcomes in the event trail with source=procedure', async () => {
    const log = new JsonlFileEventLog({ baseDir: join(mkdtempSync(join(tmpdir(), 'proc-')), 'events') });
    const sup = makeSupervisor({
      procedures: await libraryWith(procedure),
      toolRunner: new ToolRunner({
        eventLog: log,
        context: {
          logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: undefined }) },
        },
      }),
      eventLog: log,
    });
    await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('p7'), bundle });
    const outcomes: string[] = [];
    for await (const e of log.query({ correlationId: 'p7' })) {
      if (e.kind === 'agent_outcome') outcomes.push(e.finalResult.summary);
    }
    expect(outcomes.some((s) => s.includes('via:procedure'))).toBe(true);
  });
});

describe('SupervisorAgent efficacy stats', () => {
  it('stamps stats on agent_outcome for both pipeline and procedure sources', async () => {
    const log = new JsonlFileEventLog({ baseDir: join(mkdtempSync(join(tmpdir(), 'stats-')), 'events') });
    const sup = makeSupervisor({
      procedures: await libraryWith(procedure),
      toolRunner: new ToolRunner({
        eventLog: log,
        context: { logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: undefined }) } },
      }),
      eventLog: log,
    });
    // s-dance: no matching procedure (library has only query_logs-leading;
    // this request IS query_logs... so use jira to force the dance).
    await sup.run({
      governed: governedExecute('jira_create_issue', { summary: 'x', issue_type: 'Bug' }),
      context: ctx('s-dance'),
      bundle,
    });
    // s-proc: matches the learned procedure.
    await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('s-proc'), bundle });

    const danceStats: Array<Record<string, unknown>> = [];
    for await (const e of log.query({ correlationId: 's-dance' })) {
      if (e.kind === 'agent_outcome') danceStats.push((e as unknown as Record<string, unknown>).stats as Record<string, unknown>);
    }
    const procStats: Array<Record<string, unknown>> = [];
    for await (const e of log.query({ correlationId: 's-proc' })) {
      if (e.kind === 'agent_outcome') procStats.push((e as unknown as Record<string, unknown>).stats as Record<string, unknown>);
    }
    expect(danceStats).toHaveLength(1);
    expect(danceStats[0]?.source).toBe('pipeline');
    expect((danceStats[0]?.hops as number) >= 4).toBe(true);
    expect(typeof danceStats[0]?.wallClockMs).toBe('number');
    expect(procStats).toHaveLength(1);
    expect(procStats[0]?.source).toBe('procedure');
    expect(procStats[0]?.procedureId).toBe('proc-query-logs-jira-create-issue');
    expect((procStats[0]?.hops as number)).toBe(0);
  });

  it('marks fallbackFrom when a procedure attempt degrades to the dance', async () => {
    const log = new JsonlFileEventLog({ baseDir: join(mkdtempSync(join(tmpdir(), 'fb-')), 'events') });
    const sup = makeSupervisor({
      procedures: await libraryWith(procedure),
      toolRunner: new ToolRunner({
        eventLog: log,
        context: { logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: 'boom' }) } },
      }),
      eventLog: log,
    });
    const r = await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('s-fb'), bundle });
    expect(r.source).toBe('pipeline');
    const events: Array<{ kind: string; stats?: Record<string, unknown>; finalResult: { ok: boolean } }> = [];
    for await (const e of log.query({ correlationId: 's-fb' })) {
      if (e.kind === 'agent_outcome') events.push(e as unknown as { kind: string; stats?: Record<string, unknown>; finalResult: { ok: boolean } });
    }
    // The degraded attempt must be visible: pipeline outcome carrying
    // fallbackFrom, not a silently-procedure-looking success.
    expect(events).toHaveLength(1);
    expect(events[0]?.stats?.source).toBe('pipeline');
    expect(events[0]?.stats?.fallbackFrom).toBe('proc-query-logs-jira-create-issue');
    expect(events[0]?.finalResult.ok).toBe(false);
  });

  it('reports partial replay honestly instead of re-running the mutation', async () => {
    const partial: ProcedureSpec = {
      ...procedure,
      id: 'proc-partial',
      trigger: 'query_logs → query_logs → query_logs',
      steps: [
        { agent: 'investigator', tool: 'query_logs', args: { query_string: 'lead' } },
        { agent: 'investigator', tool: 'query_logs', args: { query_string: 'hist-ok' } },
        { agent: 'investigator', tool: 'query_logs', args: { query_string: 'hist-fail' } },
      ],
    };
    // Second follow-on errors (its args make the provider fail); verification
    // fails → replay is partial, but the approved action already ran.
    const sup = makeSupervisor({
      procedures: await libraryWith(partial),
      toolRunner: new ToolRunner({
        context: {
          logProvider: {
            name: 'fake',
            query: async (q: { query: string }) =>
              q.query === 'hist-fail'
                ? { provider: 'splunk', rows: [], error: 'boom' }
                : { provider: 'splunk', rows: [], error: undefined },
          },
        },
      }),
    });
    const r = await sup.run({ governed: governedExecute('query_logs', { query_string: 'x' }), context: ctx('s-part'), bundle });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('procedure');
    expect(r.summary).toContain('partial replay');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearningLoop, reindexCrossMemory } from '../../src/learning/learning-loop';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { SupervisorAgent } from '../../src/execution/supervisor';
import { ProcedureLibrary } from '../../src/execution/procedure-library';
import { ToolRunner } from '../../src/execution/tool-runner';
import { TriageAgent } from '../../src/execution/agents/triage';
import { InvestigatorAgent } from '../../src/execution/agents/investigator';
import { ExecutorAgent } from '../../src/execution/agents/executor';
import { ReviewerAgent } from '../../src/execution/agents/reviewer';
import { OpenAiCompatibleClient } from '../../src/support-voice-agent/tools/llm';
import type { ContextBundle } from '../../src/understanding/context-assembler';
import type { GovernedAction } from '../../src/governance/decision';
import type { ToolName } from '../../src/support-voice-agent/tools/types';

let dir: string;
let outcomesDir: string;
let eventsDir: string;
let crossPath: string;
let statsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learning-loop-'));
  outcomesDir = join(dir, 'outcomes');
  eventsDir = join(dir, 'events');
  crossPath = join(dir, 'memory', 'procedures.json');
  statsPath = join(dir, 'stats', 'procedure-stats.json');
  mkdirSync(outcomesDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const successfulOutcome = (cid: string): string =>
  JSON.stringify({
    correlationId: cid,
    ts: 1,
    toolCalls: [
      { kind: 'tool_call', tool: 'query_logs', args: { query_string: 'x' }, result: { ok: true, data: {} }, latencyMs: 1, attempts: 1 },
      { kind: 'tool_call', tool: 'jira_create_issue', args: { summary: 'x', issue_type: 'Bug' }, result: { ok: true, data: {} }, latencyMs: 1, attempts: 1 },
    ],
    approvals: [],
  });

const outcomeStatsEvent = (cid: string, ok: boolean, procedureId: string) => ({
  correlationId: cid,
  ts: Date.now(),
  layer: 'execution' as const,
  source: 'internal' as const,
  kind: 'agent_outcome' as const,
  finalResult: { ok, summary: ok ? 'done' : 'failed' },
  stats: { source: 'procedure' as const, hops: 0, toolCalls: 1, wallClockMs: 50, procedureId },
});

const makeLoop = (over: Record<string, unknown> = {}) =>
  new LearningLoop({
    eventLog: new JsonlFileEventLog({ baseDir: eventsDir }),
    outcomesDir,
    crossPath,
    statsPath,
    ...over,
  });

describe('LearningLoop.tick', () => {
  it('reindexCrossMemory re-embeds the durable store and stamps the sidecar', async () => {
    const crossPath = join(dir, 'memory', 'procedures.json');
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(crossPath, JSON.stringify([{ record: { id: 'p1', text: 'procedure: query_logs', metadata: { procedure: { id: 'p1' } } }, vector: [1, 0, 0] }]), 'utf8');
    const n = await reindexCrossMemory(crossPath);
    expect(n).toBe(1);
    // Re-embedded under the loop's own embedder: a 3-dim placeholder became
    // the embedder's real output, and the identity sidecar was stamped.
    const entries = JSON.parse(readFileSync(crossPath, 'utf8')) as Array<{ vector: number[] }>;
    expect(entries[0]!.vector.length).toBeGreaterThan(3);
    expect(readFileSync(crossPath + '.meta.json', 'utf8')).toContain('embedderIdentity');
  });
  it('extracts procedures from outcomes and loads them into the library', async () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(outcomesDir, 'o' + String(i) + '.json'), successfulOutcome('o' + String(i)));
    const loop = makeLoop();
    const r = await loop.tick();
    expect(r.extracted).toBe(1);
    expect(r.errors).toEqual([]);
    expect(loop.library.size()).toBe(1);
    // Snapshot persisted for ops.
    expect(existsSync(statsPath)).toBe(true);
  });

  it('the constructed library survives a restart (durable crossPath)', async () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(outcomesDir, 'o' + String(i) + '.json'), successfulOutcome('o' + String(i)));
    await makeLoop().tick();

    const restarted = makeLoop();
    await restarted.tick();
    expect(restarted.library.size()).toBe(1);
  });

  it('feeds live outcomes back: blended successRate lands in durable memory', async () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(outcomesDir, 'o' + String(i) + '.json'), successfulOutcome('o' + String(i)));
    const loop = makeLoop({ minLiveSuccessRate: 0.5 });
    await loop.tick();

    const log = new JsonlFileEventLog({ baseDir: eventsDir });
    const tracker = loop.tracker;
    await log.append(outcomeStatsEvent('live1', false, 'proc-query-logs-jira-create-issue'));
    await tracker.scan();
    const r = await loop.tick();
    expect(r.updated).toBe(1);
    expect(r.retired).toBe(0);

    const persisted = JSON.parse(readFileSync(crossPath, 'utf8')) as Array<{ record: { metadata: { procedure: { successRate: number; sampleSize: number } } } }>;
    const proc = persisted[0]?.record.metadata.procedure;
    // (3 extracted + 0 live ok) / (3 + 1 live) = 0.75
    expect(proc?.successRate).toBeCloseTo(0.75);
    expect(proc?.sampleSize).toBe(4);
  });

  it('tolerates failing stages: collects errors, extraction still runs, never throws', async () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(outcomesDir, 'o' + String(i) + '.json'), successfulOutcome('o' + String(i)));
    const throwingLog = {
      // query() is async-iterable; a broken backend throws synchronously.
      query: () => {
        throw new Error('log backend down');
      },
    };
    const loop = makeLoop({ eventLog: throwingLog });
    const r = await loop.tick();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join(' ')).toContain('log backend down');
    // The extract stage still ran in the SAME tick despite the broken log.
    expect(r.extracted).toBe(1);
    expect(loop.library.size()).toBe(1);
  });
});

describe('LearningLoop scheduling', () => {
  it('reports scheduled ticks to onTick (scheduled ticks were silent before)', async () => {
    const seen: Array<{ extracted: number }> = [];
    const loop = new LearningLoop({
      eventLog: new JsonlFileEventLog({ baseDir: join(dir, 'ev-onTick') }),
      outcomesDir: join(dir, 'outcomes-empty'),
      crossPath: join(dir, 'memory', 'ontick.json'),
      onTick: (r) => seen.push({ extracted: r.extracted }),
    });
    loop.start(30);
    await new Promise((r) => setTimeout(r, 150));
    loop.stop();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.extracted).toBe(0);
  });
  it('start() ticks on the interval and stop() ends the schedule', async () => {
    vi.useFakeTimers();
    const loop = makeLoop();
    const tickSpy = vi.spyOn(loop, 'tick').mockResolvedValue({
      extracted: 0, observed: 0, updated: 0, retired: 0, librarySize: 0, errors: [],
    });
    loop.start(1_000);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    loop.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickSpy.mock.calls.length).toBe(3);
  });

  it('start() does not tick immediately unless runOnStart is set', async () => {
    vi.useFakeTimers();
    const loop = makeLoop();
    const tickSpy = vi.spyOn(loop, 'tick').mockResolvedValue({
      extracted: 0, observed: 0, updated: 0, retired: 0, librarySize: 0, errors: [],
    });
    loop.start(60_000);
    expect(tickSpy).not.toHaveBeenCalled();
    loop.runOnStart = true;
    loop.start(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(tickSpy).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('start() is idempotent (replaces, never stacks intervals)', async () => {
    vi.useFakeTimers();
    const loop = makeLoop();
    const tickSpy = vi.spyOn(loop, 'tick').mockResolvedValue({
      extracted: 0, observed: 0, updated: 0, retired: 0, librarySize: 0, errors: [],
    });
    loop.start(1_000);
    loop.start(1_000);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(tickSpy.mock.calls.length).toBe(2); // not 4–5
    loop.stop();
  });
});

describe('LearningLoop → Supervisor integration', () => {
  it('the loop-built library short-circuits the supervisor after a tick', async () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(outcomesDir, 'o' + String(i) + '.json'), successfulOutcome('o' + String(i)));
    const loop = makeLoop();
    await loop.tick();

    // Unwired LLM → deterministic agent fallbacks; procedure path needs none.
    const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    const allowDecision = { effect: 'allow' as const, reason: 't', policyIds: [] };
    const bundle: ContextBundle = {
      envelope: { intent: { kind: 'unknown' }, confidence: 0, entities: {}, rawContext: { source: 'meeting', ts: 1, payload: {} } },
      episodes: [],
      recent: [],
    };
    const sup = new SupervisorAgent({
      triage: new TriageAgent({ llm }),
      investigator: new InvestigatorAgent({ llm }),
      executor: new ExecutorAgent({ llm }),
      reviewer: new ReviewerAgent({ llm }),
      toolRunner: new ToolRunner({
        context: { logProvider: { name: 'fake', query: async () => ({ provider: 'splunk', rows: [], error: undefined }) } },
      }),
      procedures: loop.library,
    });
    const governed: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'query_logs' as ToolName, args: { query_string: 'SUPPORT-7' } },
    };
    const r = await sup.run({
      governed,
      context: { correlationId: 'live-1', speakerId: 'u1', tokens: { prompt: 0, completion: 0 }, candidateOutput: '', toolCallHistory: [] },
      bundle,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('procedure');
    expect(r.hops).toBe(0);
  });

  it('library is a ProcedureLibrary wired to the durable crossPath', () => {
    const loop = makeLoop();
    expect(loop.library).toBeInstanceOf(ProcedureLibrary);
  });
});

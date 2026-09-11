import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EfficacyTracker } from '../../src/learning/efficacy-tracker';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { EpisodicMemory } from '../../src/understanding/memory/episodic';
import type { ProcedureSpec } from '../../src/learning/knowledge-extractor';

let dir: string;
let log: JsonlFileEventLog;

type OutcomeStats = {
  source: 'pipeline' | 'procedure';
  hops: number;
  toolCalls: number;
  wallClockMs: number;
  procedureId?: string;
  fallbackFrom?: string;
  reviewRetries?: number;
};

const procStats = (over: Partial<OutcomeStats> = {}): OutcomeStats => ({
  source: 'procedure',
  hops: 0,
  toolCalls: 1,
  wallClockMs: 40,
  procedureId: 'proc-logs',
  ...over,
});

const outcomeEvent = (cid: string, ok: boolean, stats?: OutcomeStats) => ({
  correlationId: cid,
  ts: Date.now(),
  layer: 'execution' as const,
  source: 'internal' as const,
  kind: 'agent_outcome' as const,
  finalResult: { ok, summary: ok ? 'done' : 'failed' },
  stats,
});

const specFor = (id: string, over: Partial<ProcedureSpec> = {}): ProcedureSpec => ({
  id,
  trigger: 'query_logs → jira_create_issue',
  steps: [{ agent: 'investigator', tool: 'query_logs', args: {} }],
  successRate: 1,
  sampleSize: 3,
  ...over,
});

async function storeProcedure(episodic: EpisodicMemory, spec: ProcedureSpec): Promise<void> {
  await episodic.record('cross', {
    id: spec.id,
    text: 'procedure: ' + spec.trigger,
    metadata: { procedure: spec },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'efficacy-'));
  log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('EfficacyTracker.scan', () => {
  it('aggregates procedure and pipeline performance from agent_outcome events', async () => {
    await log.append(outcomeEvent('p1', true, procStats({ wallClockMs: 40 })));
    await log.append(outcomeEvent('p2', true, procStats({ wallClockMs: 80, procedureId: 'proc-logs' })));
    await log.append(outcomeEvent('p3', false, procStats({ wallClockMs: 60 })));
    await log.append(outcomeEvent('d1', true, { source: 'pipeline', hops: 5, toolCalls: 6, wallClockMs: 900 }));
    await log.append(outcomeEvent('d2', true, {
      source: 'pipeline', hops: 4, toolCalls: 4, wallClockMs: 700, fallbackFrom: 'proc-logs',
    }));

    const tracker = new EfficacyTracker({ eventLog: log, episodic: new EpisodicMemory({}) });
    const { observed } = await tracker.scan();
    expect(observed).toBe(5);

    const snap = tracker.snapshot();
    const proc = snap.procedures.find((p) => p.procedureId === 'proc-logs');
    expect(proc?.served).toBe(3);
    expect(proc?.okCount).toBe(2);
    expect(proc?.avgWallClockMs).toBe(60);
    expect(snap.pipeline.served).toBe(2);
    expect(snap.pipeline.fallbacks).toBe(1);
    expect(snap.pipeline.avgToolCalls).toBe(5); // (6 + 4) / 2
  });

  it('aggregates review-retry evidence into the pipeline bucket', async () => {
    // 4 pipeline requests: one recovered after 2 retries, one recovered after 1,
    // one retried but still failed, one never retried.
    await log.append(outcomeEvent('r1', true, { source: 'pipeline', hops: 9, toolCalls: 3, wallClockMs: 800, reviewRetries: 2 }));
    await log.append(outcomeEvent('r2', true, { source: 'pipeline', hops: 6, toolCalls: 2, wallClockMs: 500, reviewRetries: 1 }));
    await log.append(outcomeEvent('r3', false, { source: 'pipeline', hops: 6, toolCalls: 1, wallClockMs: 400, reviewRetries: 1 }));
    await log.append(outcomeEvent('r4', true, { source: 'pipeline', hops: 3, toolCalls: 1, wallClockMs: 200 }));
    const tracker = new EfficacyTracker({ eventLog: log, episodic: new EpisodicMemory({}) });
    await tracker.scan();
    const p = tracker.snapshot().pipeline;
    expect(p.retried).toBe(3);
    expect(p.recovered).toBe(2); // r1 + r2; r3 failed after retries
    expect(p.recoveryRate).toBeCloseTo(2 / 3);
    expect(p.avgReviewRetries).toBeCloseTo(1); // (2+1+1+0)/4
  });

  it('keeps zero retry aggregates when no request spent budget (legacy shape)', async () => {
    await log.append(outcomeEvent('n1', true, { source: 'pipeline', hops: 3, toolCalls: 1, wallClockMs: 100 }));
    const tracker = new EfficacyTracker({ eventLog: log, episodic: new EpisodicMemory({}) });
    await tracker.scan();
    const p = tracker.snapshot().pipeline;
    expect(p.retried).toBe(0);
    expect(p.recovered).toBe(0);
    expect(p.recoveryRate).toBe(0);
    expect(p.avgReviewRetries).toBe(0);
  });

  it('ignores legacy agent_outcome events without stats', async () => {
    await log.append(outcomeEvent('old1', true));
    const tracker = new EfficacyTracker({ eventLog: log, episodic: new EpisodicMemory({}) });
    const { observed } = await tracker.scan();
    expect(observed).toBe(0);
    expect(tracker.snapshot().procedures).toEqual([]);
    expect(tracker.snapshot().pipeline.served).toBe(0);
  });

  it('does not double count across scans', async () => {
    const tracker = new EfficacyTracker({ eventLog: log, episodic: new EpisodicMemory({}) });
    await log.append(outcomeEvent('a1', true, procStats()));
    expect((await tracker.scan()).observed).toBe(1);
    expect((await tracker.scan()).observed).toBe(1); // same event, not re-counted
    await log.append(outcomeEvent('a2', true, procStats()));
    expect((await tracker.scan()).observed).toBe(2); // cumulative, a1 + a2
    expect(tracker.snapshot().procedures[0]?.served).toBe(2);
  });

  it('persists a snapshot to statsPath when configured', async () => {
    const statsPath = join(dir, 'efficacy', 'procedure-stats.json');
    const tracker = new EfficacyTracker({ eventLog: log, episodic: new EpisodicMemory({}), statsPath });
    await log.append(outcomeEvent('a1', true, procStats({ wallClockMs: 25 })));
    await tracker.scan();
    const persisted = JSON.parse(readFileSync(statsPath, 'utf8')) as {
      procedures: Array<{ procedureId: string; served: number; avgWallClockMs: number }>;
    };
    expect(persisted.procedures[0]?.procedureId).toBe('proc-logs');
    expect(persisted.procedures[0]?.served).toBe(1);
    expect(persisted.procedures[0]?.avgWallClockMs).toBe(25);
  });
});

describe('EfficacyTracker.applyFeedback', () => {
  it('blends live outcomes into successRate and persists the update', async () => {
    const episodic = new EpisodicMemory({});
    await storeProcedure(episodic, specFor('proc-logs', { sampleSize: 3, successRate: 1 }));
    await log.append(outcomeEvent('a1', false, procStats()));
    await log.append(outcomeEvent('a2', true, procStats()));

    const tracker = new EfficacyTracker({ eventLog: log, episodic, minLiveSuccessRate: 0.5 });
    await tracker.scan();
    const { updated, retired } = await tracker.applyFeedback();
    expect(updated).toBe(1);
    expect(retired).toBe(0);

    const hits = await episodic.recall('cross', 'procedure:', 10, 0);
    const updatedSpec = hits
      .map((h) => (h.metadata as { procedure: ProcedureSpec }).procedure)
      .find((p) => p.id === 'proc-logs');
    // (3 extracted successes + 1 live ok) / (3 + 2 live) = 0.8
    expect(updatedSpec?.successRate).toBeCloseTo(0.8);
    expect(updatedSpec?.sampleSize).toBe(5);
  });

  it('retires a procedure whose blended rate drops below the threshold', async () => {
    const episodic = new EpisodicMemory({});
    await storeProcedure(episodic, specFor('proc-bad', { sampleSize: 3, successRate: 1 }));
    for (let i = 0; i < 5; i++) {
      await log.append(outcomeEvent('f' + String(i), false, procStats({ procedureId: 'proc-bad' })));
    }
    const tracker = new EfficacyTracker({ eventLog: log, episodic, minLiveSuccessRate: 0.5 });
    await tracker.scan();
    const { retired } = await tracker.applyFeedback();
    expect(retired).toBe(1);
    expect(await episodic.recall('cross', 'procedure:', 10, 0)).toHaveLength(0);
  });

  it('skips procedures with no stored spec (stale stats are not fatal)', async () => {
    await log.append(outcomeEvent('a1', true, procStats({ procedureId: 'ghost-proc' })));
    const tracker = new EfficacyTracker({ eventLog: log, episodic: new EpisodicMemory({}) });
    await tracker.scan();
    const r = await tracker.applyFeedback();
    expect(r.updated).toBe(0);
    expect(r.retired).toBe(0);
  });

  it('blends toward the live truth without letting one failure destroy strong evidence', async () => {
    const episodic = new EpisodicMemory({});
    await storeProcedure(episodic, specFor('proc-solid', { sampleSize: 9, successRate: 1 }));
    await log.append(outcomeEvent('a1', false, procStats({ procedureId: 'proc-solid' })));
    const tracker = new EfficacyTracker({ eventLog: log, episodic, minLiveSuccessRate: 0.5 });
    await tracker.scan();
    await tracker.applyFeedback();
    const hits = await episodic.recall('cross', 'procedure:', 10, 0);
    const p = hits
      .map((h) => (h.metadata as { procedure: ProcedureSpec }).procedure)
      .find((x) => x.id === 'proc-solid');
    // (9 + 0) / (9 + 1) = 0.9 — dented, not destroyed.
    expect(p?.successRate).toBeCloseTo(0.9);
    expect(p?.sampleSize).toBe(10);
  });
});

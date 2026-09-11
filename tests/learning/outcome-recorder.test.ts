import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeRecorder } from '../../src/learning/outcome-recorder';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { DecisionEvent } from '../../src/event-log/types';

let dir: string;
let eventsDir: string;
let outcomesDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outcome-'));
  eventsDir = join(dir, 'events');
  outcomesDir = join(dir, 'outcomes');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('OutcomeRecorder', () => {
  it('joins events by correlationId and writes an OutcomeRecord', async () => {
    const log = new JsonlFileEventLog({ baseDir: eventsDir });
    const rec = new OutcomeRecorder({ eventLog: log, outcomesDir });
    const cid = 'cid-1';

    const seq: DecisionEvent[] = [
      { correlationId: cid, ts: 1, layer: 'execution', source: 'internal', kind: 'tool_call', tool: 'query_logs', args: { query_string: 'errors' }, result: { ok: true, data: { rows: [] } }, latencyMs: 10, attempts: 1 },
      { correlationId: cid, ts: 2, layer: 'governance', source: 'slack', kind: 'approval_granted', approvalId: 'a1', signerRole: 'admin' },
      { correlationId: cid, ts: 3, layer: 'execution', source: 'internal', kind: 'agent_outcome', finalResult: { ok: true, summary: 'done' } },
    ];
    for (const e of seq) await log.append(e);

    const got = await rec.record(cid);
    expect(got).toBeDefined();
    expect(got?.finalResult?.ok).toBe(true);
    expect(got?.toolCalls).toHaveLength(1);
    expect(got?.approvals).toHaveLength(1);
    expect(got?.approvals[0]?.signerRole).toBe('admin');

    const files = readdirSync(outcomesDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const json = JSON.parse(readFileSync(join(outcomesDir, files[0] ?? ''), 'utf8')) as { correlationId: string };
    expect(json.correlationId).toBe(cid);
  });

  it('carries stats.reviewRetries onto the record when the outcome event has it', async () => {
    const log = new JsonlFileEventLog({ baseDir: eventsDir });
    const rec = new OutcomeRecorder({ eventLog: log, outcomesDir });
    const cid = 'cid-retry';
    await log.append({
      correlationId: cid, ts: 1, layer: 'execution', source: 'internal', kind: 'agent_outcome',
      finalResult: { ok: true, summary: 'done' },
      stats: { source: 'pipeline', hops: 9, toolCalls: 2, wallClockMs: 500, reviewRetries: 1 },
    });
    const got = await rec.record(cid);
    expect(got?.reviewRetries).toBe(1);
  });

  it('omits reviewRetries for legacy outcome events without stats', async () => {
    const log = new JsonlFileEventLog({ baseDir: eventsDir });
    const rec = new OutcomeRecorder({ eventLog: log, outcomesDir });
    await log.append({ correlationId: 'cid-legacy', ts: 1, layer: 'execution', source: 'internal', kind: 'agent_outcome', finalResult: { ok: true, summary: 'done' } });
    const got = await rec.record('cid-legacy');
    expect(got?.reviewRetries).toBeUndefined();
  });

  it('returns a record with no finalResult when the agent outcome is missing', async () => {
    const log = new JsonlFileEventLog({ baseDir: eventsDir });
    const rec = new OutcomeRecorder({ eventLog: log, outcomesDir });
    await log.append({ correlationId: 'cid-2', ts: 1, layer: 'execution', source: 'internal', kind: 'tool_call', tool: 'query_logs', args: {}, result: { ok: true, data: {} }, latencyMs: 1, attempts: 1 });
    const got = await rec.record('cid-2');
    expect(got).toBeDefined();
    expect(got?.finalResult).toBeUndefined();
  });

  it('returns undefined when no events exist for the correlationId', async () => {
    const log = new JsonlFileEventLog({ baseDir: eventsDir });
    const rec = new OutcomeRecorder({ eventLog: log, outcomesDir });
    expect(await rec.record('nope')).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { DecisionEvent } from '../../src/event-log/types';
import { correlationId } from '../../src/event-log/correlation';

let dir: string;
let log: JsonlFileEventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-'));
  log = new JsonlFileEventLog({ baseDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ev = (over: Partial<DecisionEvent> = {}): DecisionEvent => ({
  correlationId: correlationId(),
  ts: 1_700_000_000_000,
  layer: 'governance',
  source: 'internal',
  kind: 'governance',
  intent: { intent: { kind: 'unknown' }, confidence: 0, entities: {}, rawContext: { source: 'internal', ts: 0, payload: {} } },
  decision: { effect: 'allow', reason: 'test', policyIds: [] },
  ...over,
} as DecisionEvent);

describe('JsonlFileEventLog', () => {
  it('appends and reads back the same event', async () => {
    const e = ev();
    await log.append(e);
    const out: DecisionEvent[] = [];
    for await (const x of log.query({})) out.push(x);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(e);
  });

  it('segments files by date', async () => {
    await log.append(ev({ ts: 1_700_000_000_000 })); // 2023-11-14
    await log.append(ev({ ts: 1_700_086_400_000 })); // 2023-11-15
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    expect(files.length).toBe(2);
    expect(files[0]).toMatch(/^2023-11-14\.jsonl$/);
    expect(files[1]).toMatch(/^2023-11-15\.jsonl$/);
  });

  it('appends multiple events to the same file', async () => {
    await log.append(ev());
    await log.append(ev());
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const lines = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('filters by kind', async () => {
    await log.append(ev({ kind: 'governance' }));
    await log.append(ev({ kind: 'tool_call', tool: 'query_logs', args: {}, result: { ok: true, data: null }, latencyMs: 1, attempts: 1 } as unknown as DecisionEvent));
    const out: DecisionEvent[] = [];
    for await (const x of log.query({ kind: 'tool_call' })) out.push(x);
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe('tool_call');
  });

  it('filters by correlationId', async () => {
    await log.append(ev({ correlationId: 'c1' }));
    await log.append(ev({ correlationId: 'c2' }));
    const out: DecisionEvent[] = [];
    for await (const x of log.query({ correlationId: 'c1' })) out.push(x);
    expect(out.length).toBe(1);
    expect(out[0]!.correlationId).toBe('c1');
  });

  it('yields nothing when the directory does not exist', async () => {
    const empty = new JsonlFileEventLog({ baseDir: join(dir, 'does-not-exist') });
    const out: DecisionEvent[] = [];
    for await (const x of empty.query({})) out.push(x);
    expect(out).toHaveLength(0);
  });
});

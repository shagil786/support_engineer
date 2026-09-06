import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeExtractor } from '../../src/learning/knowledge-extractor';
import { EpisodicMemory } from '../../src/understanding/memory/episodic';
import { InMemoryVectorMemory } from '../../src/understanding/memory/vector';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'know-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const outcomeWith = (cid: string, tools: string[]): string =>
  JSON.stringify({
    correlationId: cid,
    ts: 1,
    toolCalls: tools.map((t, i) => ({
      kind: 'tool_call', tool: t,
      args: { index: i },
      result: { ok: true, data: {} },
      latencyMs: 1, attempts: 1,
    })),
    approvals: [],
  });

describe('KnowledgeExtractor', () => {
  it('extracts a procedure from repeated successful tool sequences and stores it in episodic memory', async () => {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, `o${i}.json`), outcomeWith(`o${i}`, ['query_logs', 'jira_create_issue']));
    }
    const episodic = new EpisodicMemory({});
    const ext = new KnowledgeExtractor({ outcomesDir: dir, episodic });
    const procs = await ext.extract();
    expect(procs).toHaveLength(1);
    expect(procs[0]?.sampleSize).toBe(3);
    expect(procs[0]?.steps.map((s) => s.tool)).toEqual(['query_logs', 'jira_create_issue']);
    expect(procs[0]?.successRate).toBe(1);
    expect(episodic.size('cross')).toBe(1);
  });

  it('does not extract a procedure from a single occurrence', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'one.json'), outcomeWith('one', ['query_logs']));
    const ext = new KnowledgeExtractor({ outcomesDir: dir, episodic: new EpisodicMemory({}) });
    expect(await ext.extract()).toEqual([]);
  });

  it('separates sequences that share tools but differ in outcome', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a1.json'), outcomeWith('a1', ['query_logs']));
    writeFileSync(join(dir, 'a2.json'), outcomeWith('a2', ['query_logs']));
    writeFileSync(join(dir, 'b1.json'), JSON.stringify({
      correlationId: 'b1', ts: 1,
      toolCalls: [{ kind: 'tool_call', tool: 'query_logs', args: {}, result: { ok: false, error: 'nope' }, latencyMs: 1, attempts: 1 }],
      approvals: [],
    }));
    // a-sequence qualifies (2 successes of query_logs); b1 failed and must not
    // be folded into the success-rate computation.
    const episodic = new EpisodicMemory({});
    const procs = await new KnowledgeExtractor({ outcomesDir: dir, episodic }).extract();
    expect(procs).toHaveLength(1);
    expect(procs[0]?.sampleSize).toBe(2);
  });

  it('tolerates malformed outcome files and an empty directory', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{oops');
    const ext = new KnowledgeExtractor({ outcomesDir: dir, episodic: new EpisodicMemory({}) });
    expect(await ext.extract()).toEqual([]);
  });
});

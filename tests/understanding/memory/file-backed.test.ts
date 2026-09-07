import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackedVectorMemory } from '../../../src/understanding/memory/file-backed';
import { EpisodicMemory } from '../../../src/understanding/memory/episodic';
import { hashEmbedder } from '../../../src/understanding/memory/vector';
import type { ProcedureSpec } from '../../../src/learning/knowledge-extractor';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'filevec-'));
  path = join(dir, 'cross', 'procedures.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileBackedVectorMemory', () => {
  it('survives a restart: records written by one instance are searchable from another', async () => {
    const first = new FileBackedVectorMemory({ path });
    await first.add({ id: 'proc-a', text: 'procedure: query_logs → jira_create_issue' });
    await first.add({ id: 'note-b', text: 'incident note: checkout 502s splunk' });

    const second = new FileBackedVectorMemory({ path }); // "restart"
    const hits = await second.search('procedure query_logs jira_create_issue', 5, 0);
    expect(hits.map((h) => h.id)).toContain('proc-a');
    expect(second.size()).toBe(2);
  });

  it('upserts by id across restarts (no duplicate records)', async () => {
    const first = new FileBackedVectorMemory({ path });
    await first.add({ id: 'x', text: 'original' });
    await first.add({ id: 'x', text: 'updated' });
    expect(first.size()).toBe(1);

    const second = new FileBackedVectorMemory({ path });
    expect(second.size()).toBe(1);
    const hits = await second.search('updated', 3, 0);
    expect(hits[0]?.text).toBe('updated');
  });

  it('persists purge results', async () => {
    const first = new FileBackedVectorMemory({ path });
    await first.add({ id: 'keep', text: 'keep me' });
    await first.add({ id: 'drop', text: 'drop me' });
    expect(await first.purge((r) => r.id === 'drop')).toBe(1);

    const second = new FileBackedVectorMemory({ path });
    expect(second.size()).toBe(1);
    expect((await second.search('drop', 3, 0)).map((h) => h.id)).not.toContain('drop');
  });

  it('starts empty on a missing file and creates it on first mutation', async () => {
    const store = new FileBackedVectorMemory({ path });
    expect(store.size()).toBe(0);
    expect(existsSync(path)).toBe(false);
    await store.add({ id: 'a', text: 'x' });
    expect(existsSync(path)).toBe(true);
  });

  it('fails open on a corrupt snapshot: empty store, then repairs on next mutation', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'cross'), { recursive: true });
    writeFileSync(path, '{ not valid json !!!');

    const store = new FileBackedVectorMemory({ path });
    expect(store.size()).toBe(0);
    await store.add({ id: 'fresh', text: 'fresh data' });

    const second = new FileBackedVectorMemory({ path });
    expect(second.size()).toBe(1);
    expect((await second.search('fresh', 1, 0))[0]?.id).toBe('fresh');
  });

  it('recall works across restarts with the same deterministic embedder', async () => {
    const first = new FileBackedVectorMemory({ path });
    await first.add({ id: 'p', text: 'procedure: restart checkout pod' });

    const second = new FileBackedVectorMemory({ path, embedder: hashEmbedder });
    const hits = await second.search('restart checkout pod', 1, 0);
    expect(hits[0]?.id).toBe('p');
    // Identical text is the top hit with a strong score (hashEmbedder's
    // bigram/trigram weighting keeps exact-text cosine below 1.0).
  });

  it('leaves no temp files behind (atomic writes)', async () => {
    const store = new FileBackedVectorMemory({ path });
    await store.add({ id: 'a', text: 'x' });
    await store.add({ id: 'b', text: 'y' });
    await store.purge(() => true);
    const siblings = readdirSync(join(dir, 'cross'));
    expect(siblings).toEqual(['procedures.json']);
  });

  it('honors a custom embedder consistently across instances', async () => {
    const tiny = (text: string): number[] => [text.includes('checkout') ? 1 : 0, 1];
    const first = new FileBackedVectorMemory({ path, embedder: tiny });
    await first.add({ id: 'c', text: 'checkout down' });
    await first.add({ id: 'd', text: 'database up' });

    const second = new FileBackedVectorMemory({ path, embedder: tiny });
    const hits = await second.search('checkout', 1, 0.5);
    expect(hits[0]?.id).toBe('c');
  });

  it('fails LOUD when the embedder dimension mismatches persisted vectors (add)', async () => {
    // Persist under a 3-dim embedder, then reopen under a 4-dim one: cosine
    // over mismatched dims silently zero-pads and returns garbage scores —
    // the store must refuse instead.
    const dim3 = (text: string): number[] => [text.length, 1, 2];
    const dim4 = (text: string): number[] => [text.length, 1, 2, 3];
    const first = new FileBackedVectorMemory({ path, embedder: dim3 });
    await first.add({ id: 'a', text: 'seeded under dim3' });

    const second = new FileBackedVectorMemory({ path, embedder: dim4 });
    await expect(second.add({ id: 'b', text: 'new under dim4' })).rejects.toThrow(/reindex/);
  });

  it('fails LOUD when the embedder dimension mismatches persisted vectors (search)', async () => {
    const dim3 = (text: string): number[] => [text.length, 1, 2];
    const dim4 = (text: string): number[] => [text.length, 1, 2, 3];
    const first = new FileBackedVectorMemory({ path, embedder: dim3 });
    await first.add({ id: 'a', text: 'seeded under dim3' });

    const second = new FileBackedVectorMemory({ path, embedder: dim4 });
    await expect(second.search('anything', 3, 0)).rejects.toThrow(/reindex/);
  });

  it('same-dim different-backend vectors still load (dim alone is not proof of mismatch)', async () => {
    // Dimension equality is necessary, not sufficient — a same-dim backend
    // swap (e.g. two different 384-dim models) cannot be detected here and
    // remains the operator's responsibility. This test pins the non-guard:
    // a same-dim reopen must NOT throw.
    const dim3a = (text: string): number[] => [text.length, 1, 2];
    const dim3b = (text: string): number[] => [1, text.length, 2];
    const first = new FileBackedVectorMemory({ path, embedder: dim3a });
    await first.add({ id: 'a', text: 'seeded under dim3a' });

    const second = new FileBackedVectorMemory({ path, embedder: dim3b });
    await expect(second.search('anything', 3, 0)).resolves.toBeDefined();
  });

  it('reindex() resolves the mismatch and search recovers', async () => {
    const dim3 = (text: string): number[] => [text.length, 1, 2];
    const dim4 = (text: string): number[] => [text.length, 1, 2, 3];
    const first = new FileBackedVectorMemory({ path, embedder: dim3 });
    await first.add({ id: 'a', text: 'seeded under dim3' });

    const second = new FileBackedVectorMemory({ path, embedder: dim4 });
    expect(await second.reindex()).toBe(1);
    const hits = await second.search('seeded under dim3', 1, 0);
    expect(hits[0]?.id).toBe('a');
  });
});

describe('EpisodicMemory crossPath persistence', () => {
  const specFor = (id: string): ProcedureSpec => ({
    id,
    trigger: 'query_logs → jira_create_issue',
    steps: [{ agent: 'investigator', tool: 'query_logs', args: {} }],
    successRate: 1,
    sampleSize: 4,
  });

  it('learned procedures survive a restart', async () => {
    const first = new EpisodicMemory({ crossPath: path });
    const spec = specFor('proc-durable');
    await first.record('cross', { id: spec.id, text: 'procedure: ' + spec.trigger, metadata: { procedure: spec } });

    const second = new EpisodicMemory({ crossPath: path }); // "restart"
    const hits = await second.recall('cross', 'procedure:', 10, 0);
    expect(hits).toHaveLength(1);
    expect((hits[0]?.metadata as { procedure: ProcedureSpec }).procedure.id).toBe('proc-durable');
  });

  it('purgeCross persists across a restart (retirement is durable)', async () => {
    const first = new EpisodicMemory({ crossPath: path });
    const spec = specFor('proc-doomed');
    await first.record('cross', { id: spec.id, text: 'procedure: ' + spec.trigger, metadata: { procedure: spec } });
    expect(await first.purgeCross((r) => r.id === 'proc-doomed')).toBe(1);

    const second = new EpisodicMemory({ crossPath: path });
    expect(await second.recall('cross', 'procedure:', 10, 0)).toHaveLength(0);
  });

  it('per-meeting scope stays ephemeral even when cross is durable', async () => {
    const first = new EpisodicMemory({ crossPath: path });
    await first.record('perMeeting', { id: 'm1', text: 'meeting note' }, { meetingId: 'meet-9' });

    const second = new EpisodicMemory({ crossPath: path });
    expect(await second.recall('perMeeting', 'meeting note', 5, 0)).toHaveLength(0);
    expect(second.size('cross')).toBe(0);
  });
});

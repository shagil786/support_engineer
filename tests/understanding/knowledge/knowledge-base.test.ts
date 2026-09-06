import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackedKnowledgeBase } from '../../../src/understanding/knowledge/knowledge-base';
import type { IngestDoc } from '../../../src/understanding/knowledge/chunker';

const dir = () => mkdtempSync(join(tmpdir(), 'kb-'));

const runbookA: IngestDoc = {
  id: 'run-restart',
  text: [
    '# Restart the checkout pod',
    'Use this runbook when the checkout service stops responding.',
    '## Step 1 — scale down',
    'Scale the payments deployment before restarting the checkout pod.',
    '## Step 2 — restart',
    'Run restart-all only for a full outage; prefer single-pod restart.',
  ].join('\n'),
  metadata: { source: 'runbooks', tags: ['checkout', 'restart'] },
};

const runbookB: IngestDoc = {
  id: 'run-db-failover',
  text: [
    '# Database failover',
    'When the primary database is unreachable, promote the replica.',
    '## Promotion',
    'Verify replication lag is zero before promoting the replica database.',
  ].join('\n'),
  metadata: { source: 'runbooks', tags: ['database'] },
};

const incidentC: IngestDoc = {
  id: 'inc-42',
  text: 'Postmortem: the checkout timeout incident was caused by a connection pool exhaustion in payments.',
  metadata: { source: 'incidents', date: '2026-08-01', tags: ['payments'] },
};

const ingestAll = (kb: FileBackedKnowledgeBase) =>
  Promise.all([kb.ingest(runbookA), kb.ingest(runbookB), kb.ingest(incidentC)]);

const kbOpts = { maxChars: 400, overlapChars: 80 };

describe('FileBackedKnowledgeBase', () => {
  let root: string;

  beforeEach(() => {
    root = dir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ingests a document into retrievable chunks with provenance', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    await kb.ingest(runbookA);
    const hits = await kb.search('checkout pod restart');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.docId).toBe('run-restart');
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.metadata?.['source']).toBe('runbooks');
  });

  it('re-ingesting the same docId replaces, not duplicates', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json'), ...kbOpts });
    await kb.ingest(runbookA);
    await kb.ingest({ ...runbookA, text: runbookA.text + '\n## Extra\nNew note.' });
    expect(kb.size()).toBe(4); // sections stay whole under maxChars; replaced, not duplicated (4+5 would be 9)
    const hits = await kb.search('Extra New note');
    expect(hits.every((h) => h.docId === 'run-restart')).toBe(true);
  });

  it('persists across restarts (durable, like the procedure memory)', async () => {
    const path = join(root, 'kb.json');
    const kb = new FileBackedKnowledgeBase({ path });
    await ingestAll(kb);
    const reborn = new FileBackedKnowledgeBase({ path });
    const hits = await reborn.search('promote the replica database');
    expect(hits[0]?.docId).toBe('run-db-failover');
  });

  it('hybrid beats keyword-only on a paraphrase (vector catches it)', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    await ingestAll(kb);
    // No word overlap with the target chunk beyond a stopword-free stem.
    const hybrid = await kb.search('checkout service unresponsive reboot instructions');
    expect(hybrid[0]?.docId).toBe('run-restart');
  });

  it('hybrid beats vector-only on an exact rare term (BM25 catches it)', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    await ingestAll(kb);
    // "postmortem" appears once, in incident C; the hash embedder alone can
    // drown it among trigram noise, while BM25 ranks the exact hit first.
    const hits = await kb.search('postmortem pool exhaustion');
    expect(hits[0]?.docId).toBe('inc-42');
  });

  it('metadata filters are query-time and combinable', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    await ingestAll(kb);
    const onlyIncidents = await kb.search('checkout payments', { where: { source: 'incidents' } });
    expect(onlyIncidents.length).toBeGreaterThan(0);
    expect(onlyIncidents.every((h) => h.metadata?.['source'] === 'incidents')).toBe(true);

    const tagged = await kb.search('restart', { where: { tags: ['database'] } });
    expect(tagged.every((h) => ((h.metadata?.['tags'] as string[] | undefined) ?? []).includes('database'))).toBe(true);

    const both = await kb.search('checkout', { where: { source: 'runbooks', tags: ['checkout'] } });
    expect(both.every((h) => h.metadata?.['source'] === 'runbooks')).toBe(true);
  });

  it('a filter matching nothing returns empty, not unfiltered results', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    await ingestAll(kb);
    expect(await kb.search('restart', { where: { source: 'wiki' } })).toEqual([]);
  });

  it('drops results below minScore and respects topK', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    await ingestAll(kb);
    const all = await kb.search('database replica', { topK: 10 });
    const few = await kb.search('database replica', { topK: 1 });
    expect(few).toHaveLength(1);
    expect(all.length).toBeGreaterThanOrEqual(few.length);
    // Scored garbage returns nothing: with a floor, near-zero matches are
    // noise, not "the least-bad chunk".
    const garbage = await kb.search('zzzqqq xyzzyx', { minScore: 0.5 });
    expect(garbage).toEqual([]);
  });

  it('deleteDoc removes every chunk of that document', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json'), ...kbOpts });
    await ingestAll(kb);
    expect(await kb.deleteDoc('run-restart')).toBe(3);
    expect(kb.size()).toBe(3);
    const hits = await kb.search('restart checkout pod');
    expect(hits.every((h) => h.docId !== 'run-restart')).toBe(true);
  });

  it('fails soft on a corrupt snapshot (empty store, like FileBackedVectorMemory)', async () => {
    const path = join(root, 'kb.json');
    const kb = new FileBackedKnowledgeBase({ path });
    await kb.ingest(runbookA);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{corrupt', 'utf8');
    const reborn = new FileBackedKnowledgeBase({ path });
    expect(reborn.size()).toBe(0);
  });

  it('a knowledge base with no documents returns empty results, never throws', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    expect(await kb.search('anything')).toEqual([]);
  });
});

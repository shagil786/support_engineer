import { describe, it, expect } from 'vitest';
import { chunkDocument, Chunk } from '../../../src/understanding/knowledge/chunker';

const doc = (over: Partial<Parameters<typeof chunkDocument>[0]> = {}) => ({
  id: 'run-001',
  text: [
    '# Restart the checkout pod',
    'Run this when the checkout service stops responding but the pod is Running.',
    '',
    '## Step 1 — check saturation',
    'Query the payments dashboard. If CPU is above 90%, scale before restarting.',
    '',
    '## Step 2 — rolling restart',
    'Use the restart-all script only for a full outage; prefer the single-pod path.',
  ].join('\n'),
  metadata: { source: 'runbooks', tags: ['runbook', 'checkout'] },
  ...over,
});

describe('chunkDocument', () => {
  it('splits on section boundaries, not mid-sentence', () => {
    const chunks = chunkDocument(doc());
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.trim().endsWith(',')).toBe(false);
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it('stamps every chunk with full provenance', () => {
    const chunks = chunkDocument(doc());
    for (const c of chunks) {
      expect(c.docId).toBe('run-001');
      expect(c.index).toBeGreaterThanOrEqual(0);
      expect(c.metadata).toMatchObject({ source: 'runbooks', tags: ['runbook', 'checkout'] });
      expect(typeof c.heading).toBe('string');
    }
    // Chunk indices are dense and ordered.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('carries the current section heading for context', () => {
    const chunks = chunkDocument(doc());
    const last = chunks[chunks.length - 1] as Chunk;
    expect(last.heading).toMatch(/Step 2/i);
  });

  it('keeps small sections together and emits a single chunk for a tiny doc', () => {
    const tiny = doc({ text: 'One line. Nothing else.' });
    const chunks = chunkDocument(tiny);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('One line');
  });

  it('drops boilerplate/empty lines and never emits empty chunks', () => {
    const noisy = doc({
      text: 'Title\n\n\n\n---\n\nReal content about the payments timeout error.\n',
    });
    for (const c of chunkDocument(noisy)) expect(c.text.trim().length).toBeGreaterThan(0);
  });

  it('unwraps markdown hard-wrapped prose so sentences survive retrieval', () => {
    // A wrapped paragraph: the answerer splits candidate sentences on
    // newlines, so a line ending mid-sentence truncates KB answers at the
    // wrap point (the live bug: "...caused by connection pool").
    const wrapped = doc({
      text: [
        '# Cache incidents',
        'Postmortem: the checkout timeout incident was caused by connection pool',
        'exhaustion in the payments service, not by Redis. Mitigation was a deploy',
        'rollback plus a pool-size bump.',
      ].join('\n'),
    });
    const [chunk] = chunkDocument(wrapped) as [Chunk];
    expect(chunk.text).toContain(
      'caused by connection pool exhaustion in the payments service, not by Redis.',
    );
    // No prose line ends mid-sentence anymore.
    for (const line of chunk.text.split('\n')) {
      expect(line.endsWith('pool')).toBe(false);
      expect(line.endsWith('deploy')).toBe(false);
    }
  });

  it('keeps list lines as one-item-per-line while unwrapping prose', () => {
    const mixed = doc({
      text: [
        '# Runbook',
        'First check whether the saturation alert is firing before you do anything else.',
        '- scale the deployment to three replicas',
        '- restart the checkout pod',
        'Escalate to the on-call engineer if the pod refuses to come back.',
      ].join('\n'),
    });
    const [chunk] = chunkDocument(mixed) as [Chunk];
    expect(chunk.text).toContain('- scale the deployment to three replicas');
    expect(chunk.text).toContain('- restart the checkout pod');
    // Prose around the list is unwrapped into full sentences.
    expect(chunk.text).toContain('Escalate to the on-call engineer if the pod refuses to come back.');
  });

  it('rejects a document with no id or empty text', () => {
    expect(() => chunkDocument(doc({ id: '' }))).toThrow();
    expect(() => chunkDocument(doc({ text: '   ' }))).toThrow();
  });

  it('respects maxChars by splitting oversized sections with overlap', () => {
    const para = 'The payments service retries with exponential backoff. ';
    const big = doc({ text: `# Big\n${para.repeat(60)}` });
    const chunks = chunkDocument(big, { maxChars: 400, overlapChars: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400);
    // Consecutive oversized pieces share overlapping content.
    const [a, b] = chunks as [Chunk, Chunk];
    expect(b.text.length).toBeLessThan(para.repeat(60).length);
    expect(a.text).not.toBe(b.text);
  });
});

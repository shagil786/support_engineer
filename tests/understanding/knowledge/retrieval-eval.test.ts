import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackedKnowledgeBase } from '../../../src/understanding/knowledge/knowledge-base';
import { evaluateRetrieval, assertQualityGate } from '../../../src/understanding/knowledge/retrieval-eval';
import { RETRIEVAL_SEED_DOCS, RETRIEVAL_GOLDEN_SET } from '../../../src/fixtures/retrieval-golden-set';

describe('evaluateRetrieval', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kb-eval-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const seededKb = async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    for (const doc of RETRIEVAL_SEED_DOCS) await kb.ingest(doc);
    return kb;
  };

  it('the shipped golden set scores perfectly against the shipped seed corpus', async () => {
    const result = await evaluateRetrieval(await seededKb(), RETRIEVAL_GOLDEN_SET);
    expect(result.cases).toBe(RETRIEVAL_GOLDEN_SET.cases.length);
    expect(result.hitRate).toBe(1);
    expect(result.mrr).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it('reports hit rate and MRR honestly when relevance is missing', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    // Corpus deliberately missing the incident doc: the postmortem query fails.
    for (const doc of RETRIEVAL_SEED_DOCS.filter((d) => d.id !== 'inc-42')) await kb.ingest(doc);
    const result = await evaluateRetrieval(kb, RETRIEVAL_GOLDEN_SET);
    expect(result.cases).toBe(RETRIEVAL_GOLDEN_SET.cases.length);
    expect(result.hitRate).toBeLessThan(1);
    expect(result.failures.length).toBeGreaterThan(0);
    const failed = result.failures[0];
    expect(failed?.query).toBeTruthy();
    expect(failed?.rank ?? null).toBeNull();
    expect(failed?.expected).toContain('inc-42');
  });

  it('respects a case-level metadata filter', async () => {
    const kb = await seededKb();
    const result = await evaluateRetrieval(kb, {
      name: 'filtered',
      cases: [
        { id: 'f1', query: 'checkout', relevantDocIds: ['inc-42'], where: { source: 'incidents' } },
      ],
    });
    expect(result.hitRate).toBe(1);
    expect(result.mrr).toBe(1);
  });

  it('the quality gate passes at threshold and throws with the failing case below it', async () => {
    const good = await evaluateRetrieval(await seededKb(), RETRIEVAL_GOLDEN_SET);
    expect(() => assertQualityGate(good, { minHitRate: 1, minMrr: 0.9 })).not.toThrow();

    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb-partial.json') });
    for (const doc of RETRIEVAL_SEED_DOCS.filter((d) => d.id !== 'inc-42')) await kb.ingest(doc);
    const bad = await evaluateRetrieval(kb, RETRIEVAL_GOLDEN_SET);
    expect(() => assertQualityGate(bad, { minHitRate: 1, minMrr: 1 })).toThrow(/g3/);
  });
});

import { describe, it, expect } from 'vitest';
import { LocalEmbedder, DEFAULT_LOCAL_EMBEDDING_MODEL } from '../../../../src/understanding/memory/embedders/local';
import { EmbeddingError, mapToDim } from '../../../../src/understanding/memory/embedders/openai';
import type { FeatureExtractor, PipelineFactory, TensorLike } from '../../../../src/understanding/memory/embedders/local';

/**
 * Deterministic fake feature-extractor: mimics transformers.js semantics —
 * (texts, { pooling, normalize }) → Tensor { dims: [batch, hidden], data }.
 * Token vectors from a tiny lexicon mean the fake is *meaning-correlated*,
 * which is the property a real embedder has (the arbitrary-vector fake
 * lesson from the OpenAI embedder tests).
 */
const LEXICON: Record<string, number[]> = {
  restart: [1, 0, 0, 0],
  checkout: [0, 1, 0, 0],
  pod: [0, 0, 1, 0],
};

function fakeTensor(texts: string[], hidden = 4): TensorLike {
  const rows = texts.map((t) => {
    const words = t.toLowerCase().split(/\s+/);
    const acc = new Array<number>(hidden).fill(0);
    for (const w of words) {
      const v = LEXICON[w] ?? [0, 0, 0, 0.5];
      for (let i = 0; i < hidden; i++) acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
    }
    return acc.map((x) => x / Math.max(words.length, 1)); // mean, un-normalized
  });
  const data = new Float32Array(rows.length * hidden);
  rows.forEach((r, i) => r.forEach((x, j) => (data[i * hidden + j] = x)));
  return { dims: [rows.length, hidden], data };
}

/** Harness recording BOTH call sites: the pipeline factory (construction)
 *  and the extractor invocations (per-batch pooling options). */
function fakeHarness() {
  const factoryCalls: Array<{ task: string; model: string; opts: unknown }> = [];
  const extractorCalls: Array<{ texts: string[]; opts: unknown }> = [];
  const factory: PipelineFactory = async (task, model, opts = {}) => {
    factoryCalls.push({ task, model, opts });
    const extractor: FeatureExtractor = (texts, eopts) => {
      extractorCalls.push({ texts, opts: eopts });
      return fakeTensor(texts);
    };
    return extractor;
  };
  return { factory, factoryCalls, extractorCalls };
}

describe('LocalEmbedder', () => {
  it('defaults to the MiniLM model id and reports wired', () => {
    const e = new LocalEmbedder({ pipeline: fakeHarness().factory });
    expect(e.model).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL);
    expect(e.isWired()).toBe(true);
  });

  it('is lazy: the pipeline factory runs only on first embed, once', async () => {
    const h = fakeHarness();
    const e = new LocalEmbedder({ pipeline: h.factory });
    expect(h.factoryCalls).toHaveLength(0); // construction loads nothing
    await e.embed('restart the checkout pod');
    await e.embed('restart the checkout pod again');
    expect(h.factoryCalls).toHaveLength(1);
    expect(h.factoryCalls[0]?.task).toBe('feature-extraction');
    expect(h.factoryCalls[0]?.model).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL);
  });

  it('embeds with mean pooling + normalization requested and returns a normalized vector', async () => {
    const h = fakeHarness();
    const e = new LocalEmbedder({ pipeline: h.factory });
    const v = await e.embed('restart the checkout pod');
    expect(v).toHaveLength(4);
    const norm = Math.sqrt(v.reduce((a: number, x: number) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    // The pooling contract lives on the extractor call, not the factory call.
    expect(h.extractorCalls).toHaveLength(1);
    expect((h.extractorCalls[0]?.opts as { pooling?: string })?.pooling).toBe('mean');
    expect((h.extractorCalls[0]?.opts as { normalize?: boolean })?.normalize).toBe(true);
  });

  it('is deterministic per text and distinguishes different texts', async () => {
    const e = new LocalEmbedder({ pipeline: fakeHarness().factory });
    const a1 = await e.embed('restart the checkout pod');
    const a2 = await e.embed('restart the checkout pod');
    const b = await e.embed('restart the pod');
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  it('embedBatch preserves order and hits each text once', async () => {
    const h = fakeHarness();
    const e = new LocalEmbedder({ pipeline: h.factory });
    const [x, y, z] = await e.embedBatch(['restart checkout', 'pod restart', 'checkout pod']);
    expect(x).toHaveLength(4);
    expect(y).not.toEqual(x);
    expect(z).not.toEqual(x);
    expect(h.extractorCalls[0]?.texts).toEqual(['restart checkout', 'pod restart', 'checkout pod']);
  });

  it('folds to EMBEDDINGS_DIM and stays normalized (384 → dim)', async () => {
    const e = new LocalEmbedder({ dim: 2, pipeline: fakeHarness().factory });
    const v = await e.embed('restart the checkout pod');
    expect(v).toHaveLength(2);
    const norm = Math.sqrt(v.reduce((a: number, x: number) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    // Sanity on the folding helper itself: mapToDim preserves mass deterministically.
    expect(mapToDim([1, 0, 0, 1], 2)).toEqual([1, 1]);
  });

  it('maps pipeline load failure to EmbeddingError(model_load), never a silent zero vector', async () => {
    const e = new LocalEmbedder({
      pipeline: async () => {
        throw new Error('model download blocked');
      },
    });
    await expect(e.embed('restart the checkout pod')).rejects.toBeInstanceOf(EmbeddingError);
    await expect(e.embed('restart the checkout pod')).rejects.toMatchObject({ code: 'model_load' });
  });

  it('rejects empty batches like the other backends', async () => {
    const e = new LocalEmbedder({ pipeline: fakeHarness().factory });
    await expect(e.embedBatch([])).rejects.toMatchObject({ code: 'malformed' });
  });
});

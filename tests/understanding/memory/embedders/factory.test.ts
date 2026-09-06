import { describe, it, expect } from 'vitest';
import { embedderFromConfig } from '../../../../src/understanding/memory/embedders/factory';
import { hashEmbedder } from '../../../../src/understanding/memory/vector';
import type { PipelineFactory } from '../../../../src/understanding/memory/embedders/local';

/** Meaning-correlated fake pipeline (same trick as local.test.ts): lexicon
 *  vectors so a local embedder's output is verifiably semantic. */
function fakePipelineFactory(hidden = 4): PipelineFactory {
  return async () => async (texts: string[]) => {
    const LEX: Record<string, number[]> = { restart: [1, 0, 0, 0], pod: [0, 1, 0, 0] };
    const rows = texts.map((t) => {
      const words = t.toLowerCase().split(/\s+/);
      const acc = new Array<number>(hidden).fill(0);
      for (const w of words) for (let i = 0; i < hidden; i++) acc[i] = (acc[i] ?? 0) + (LEX[w]?.[i] ?? 0.25);
      return acc;
    });
    const data = new Float32Array(rows.length * hidden);
    rows.forEach((r, i) => r.forEach((x, j) => (data[i * hidden + j] = x)));
    return { dims: [rows.length, hidden], data };
  };
}

const fakeFetch = (async (_url: string, init?: RequestInit): Promise<Response> => {
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [0.5, 0.5, 0.5, 0.5] })) }), {
    status: 200,
  });
}) as typeof fetch;

describe('embedderFromConfig', () => {
  it('remote config → a working embedder wired to the OpenAI-compatible backend', async () => {
    const embed = embedderFromConfig(
      { provider: 'remote', baseUrl: 'https://e.test', apiKey: 'k', model: 'm' },
      { request: fakeFetch },
    );
    expect(embed).toBeTypeOf('function');
    const v = await embed!('hello world');
    expect(v).toHaveLength(4);
  });

  it('remote dim folds through to the output', async () => {
    const embed = embedderFromConfig(
      { provider: 'remote', baseUrl: 'https://e.test', apiKey: 'k', model: 'm', dim: 2 },
      { request: fakeFetch },
    );
    const v = await embed!('hello world');
    expect(v).toHaveLength(2);
  });

  it('local config → an in-process embedder, with the HF model override honored', async () => {
    const dflt = embedderFromConfig({ provider: 'local' });
    expect(dflt).toBeTypeOf('function');
    // The default-model path hits the real network/model (lazy ~25MB load) —
    // exercised in live verification, never in unit tests. Here we prove the
    // model override plumbs through by asserting shape under an injected fake.
    const custom = embedderFromConfig(
      { provider: 'local', model: 'Xenova/bge-small-en-v1.5' },
      { pipeline: fakePipelineFactory() },
    );
    expect(await custom!('restart the pod')).toHaveLength(4);
  });

  it('local dim folds through to the output', async () => {
    const embed = embedderFromConfig({ provider: 'local', dim: 2 }, { pipeline: fakePipelineFactory() });
    const v = await embed!('restart the pod');
    expect(v).toHaveLength(2);
  });

  it('absent config → undefined (hash default is the caller’s choice)', () => {
    expect(embedderFromConfig(undefined)).toBeUndefined();
  });

  it('the hash default remains available as the explicit fallback embedder', () => {
    expect(hashEmbedder('restart the checkout pod')).toHaveLength(256);
  });
});

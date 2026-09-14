import { describe, it, expect } from 'vitest';
import { embedderFromConfig } from '../../../../src/understanding/memory/embedders/factory';
import { hashEmbedder, type EmbedderLike } from '../../../../src/understanding/memory/vector';

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

  it('local config → the built-in hash embedder: byte-identical vectors, same identity', async () => {
    const embed = embedderFromConfig({ provider: 'local' });
    expect(embed).toBeTypeOf('function');
    const v = await embed!('restart the checkout pod');
    expect(v).toEqual(hashEmbedder('restart the checkout pod')); // identical vector space
    expect(embed!.identity).toBe((hashEmbedder as EmbedderLike).identity); // stores see no model swap
    // deterministic across calls and factory invocations
    const again = await embedderFromConfig({ provider: 'local' })!('restart the checkout pod');
    expect(again).toEqual(v);
  });

  it('absent config → undefined (hash default is the caller’s choice)', () => {
    expect(embedderFromConfig(undefined)).toBeUndefined();
  });

  it('the hash default remains available as the explicit fallback embedder', () => {
    expect(hashEmbedder('restart the checkout pod')).toHaveLength(256);
  });
});

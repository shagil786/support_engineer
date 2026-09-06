import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OpenAiCompatibleEmbedder,
  EmbeddingError,
  extractEmbedding,
  mapToDim,
  normalize,
  hashEmbedderCompat,
} from '../../../../src/understanding/memory/embedders/openai';
import { FileBackedVectorMemory } from '../../../../src/understanding/memory/file-backed';
import { FileBackedKnowledgeBase } from '../../../../src/understanding/knowledge/knowledge-base';

/* Deterministic fake fetch: records requests, returns dimension-stable,
 * SEMANTIC embeddings — one component per lexicon word, so shared vocabulary
 * yields shared direction (a stand-in for a real embedding model). */
const LEXICON = ['restart', 'checkout', 'pod', 'database', 'failover', 'cache', 'payments', 'deploy'];
function semanticEmbed(text: string, dim: number): number[] {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const v = new Array<number>(dim).fill(0);
  for (const w of words) {
    const idx = LEXICON.indexOf(w);
    if (idx >= 0 && idx < dim) v[idx] = (v[idx] ?? 0) + 1;
  }
  return v;
}
function fakeFetch(responses: Array<{ status: number; body: unknown }> = [], dim = 4) {
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  let call = 0;
  const json = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const reqBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    captured.push({ url: String(url), body: reqBody });
    const r = responses[call] ?? { status: 200, body: {} };
    call += 1;
    if (r.status === 200 && !('data' in (r.body as object))) {
      // Generate a response from the REQUEST's input when none is canned.
      const input = reqBody['input'];
      const inputs = Array.isArray(input) ? (input as string[]) : [String(input ?? '')];
      const data = inputs.map((text, i) => ({
        object: 'embedding',
        index: i,
        embedding: semanticEmbed(text, dim),
      }));
      return json(200, { object: 'list', data, model: 'e', usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    return json(r.status, r.body);
  };
  return { fn: fn as unknown as typeof fetch, captured };
}

describe('OpenAiCompatibleEmbedder', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'embed-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects an empty batch (api contract: one row per input)', async () => {
    const { fn } = fakeFetch();
    const e = new OpenAiCompatibleEmbedder({ baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'm', request: fn });
    await expect(e.embedBatch([])).rejects.toThrow(/empty/i);
  });

  it('is unwired without key/baseUrl/model and throws EmbeddingError', async () => {
    const e = new OpenAiCompatibleEmbedder({ baseUrl: '', apiKey: '', model: '' });
    expect(e.isWired()).toBe(false);
    await expect(e.embedBatch(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('posts the embeddings wire format to <baseUrl>/embeddings', async () => {
    const { fn, captured } = fakeFetch(undefined, 4);
    const e = new OpenAiCompatibleEmbedder({ baseUrl: 'https://e.test/v1/', apiKey: 'k', model: 'text-embedding-3-small', request: fn });
    const v = await e.embed('hello world');
    expect(captured[0]?.url).toBe('https://e.test/v1/embeddings');
    expect(captured[0]?.body).toMatchObject({ model: 'text-embedding-3-small', input: ['hello world'] });
    expect(Array.isArray(v)).toBe(true);
  });

  it('batches many inputs and returns one vector per input, in order', async () => {
    const { fn } = fakeFetch(undefined, 4);
    const e = new OpenAiCompatibleEmbedder({ baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'm', request: fn });
    const out = await e.embedBatch(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    for (const v of out) expect(v).toHaveLength(4);
  });

  it('caches per (model, text) — a repeat call performs no second HTTP request', async () => {
    const { fn, captured } = fakeFetch(undefined, 4);
    const e = new OpenAiCompatibleEmbedder({ baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'm', request: fn });
    await e.embed('same text');
    await e.embed('same text');
    expect(captured).toHaveLength(1);
  });

  it('normalizes vectors so cosine is a dot product', async () => {
    const { fn } = fakeFetch(undefined, 4);
    const e = new OpenAiCompatibleEmbedder({ baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'm', request: fn });
    const v = await e.embed('restart checkout');
    expect(v.some((x) => x !== 0)).toBe(true);
    expect(normalize(v).every((x) => Number.isFinite(x))).toBe(true);
    const s = normalize(v).reduce((a: number, x: number) => a + x * x, 0);
    expect(s).toBeCloseTo(1, 5);
  });

  it('maps off-dimension vectors via deterministic projection', async () => {
    const v = mapToDim([0.5, -1.5, 2, 0, 1, -2, 3], 3);
    expect(v).toHaveLength(3);
    for (const x of v) expect(Number.isFinite(x)).toBe(true);
  });

  it('extractEmbedding validates shape and throws EmbeddingError on junk', () => {
    expect(extractEmbedding({ data: [{ index: 0, embedding: [1, 2] }] }, 0)).toEqual([1, 2]);
    expect(() => extractEmbedding({ data: [] }, 0)).toThrow(EmbeddingError);
    expect(() => extractEmbedding({ data: [{ embedding: 'nope' }] }, 0)).toThrow(EmbeddingError);
    expect(() => extractEmbedding({ data: [{ embedding: [Number.NaN] }] }, 0)).toThrow(EmbeddingError);
  });

  it('maps HTTP/network failures to EmbeddingError codes', async () => {
    const { fn } = fakeFetch([{ status: 429, body: { error: { message: 'rate limited' } } }]);
    const e = new OpenAiCompatibleEmbedder({ baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'm', request: fn });
    const err = await e.embed('x').catch((e2: unknown) => e2);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).code).toBe('http_error');
  });

  it('hashEmbedderCompat matches the built-in hashEmbedder (stability oracle)', async () => {
    for (const text of ['restart the checkout pod', 'db failover', '', 'a']) {
      const a = await hashEmbedderCompat(text);
      const b = await hashEmbedderCompat(text);
      expect(a).toEqual(b);
      expect(a).toHaveLength(256);
    }
  });

  it('VectorMemory reindex() re-embeds under a new embedder (persisted vectors migrate)', async () => {
    const path = join(root, 'v.json');
    const old = new FileBackedVectorMemory({ path }); // hash embedder
    await old.add({ id: 'a', text: 'restart the checkout pod' });
    await old.add({ id: 'b', text: 'database failover' });

    const { fn } = fakeFetch(undefined, 8);
    const cloud = new OpenAiCompatibleEmbedder({ baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'm', dim: 8, request: fn });
    const nu = new FileBackedVectorMemory({ path, embedder: cloud.embed });
    expect(await nu.reindex()).toBe(2);
    const hits = await nu.search('checkout pod restart');
    expect(hits[0]?.id).toBe('a');

    const reborn = new FileBackedVectorMemory({ path, embedder: cloud.embed });
    expect(reborn.dim()).toBe(8);
  });

  it('KnowledgeBase reindex() re-embeds every chunk in place (docs and BM25 untouched)', async () => {
    const path = join(root, 'kb.json');
    const kb = new FileBackedKnowledgeBase({ path });
    await kb.ingest({ id: 'd1', text: '# Restart\nRestart the checkout pod when it hangs.' });
    await kb.ingest({ id: 'd2', text: 'Database failover promotes the replica.' });
    const beforeDocs = kb.docIds();
    const beforeSize = kb.size();

    const { fn } = fakeFetch(undefined, 6);
    const cloud = new OpenAiCompatibleEmbedder({ baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'm', dim: 6, request: fn });
    const migrated = new FileBackedKnowledgeBase({ path, vectorMemory: new FileBackedVectorMemory({ path: join(root, 'kb-vectors.json'), embedder: cloud.embed }), embedder: cloud.embed });
    const n = await migrated.reindex();
    expect(n).toBe(beforeSize);
    expect(migrated.docIds()).toEqual(beforeDocs);

    const hits = await migrated.search('checkout hangs');
    expect(hits[0]?.docId).toBe('d1');
  });
});

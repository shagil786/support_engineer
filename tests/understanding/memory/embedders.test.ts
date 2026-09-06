import { describe, it, expect } from 'vitest';
import { InMemoryKeyValueStore } from '../../../src/understanding/memory/kv';
import { hashEmbedder, cosine, InMemoryVectorMemory } from '../../../src/understanding/memory/vector';
import { resolveEmbedder } from '../../../src/understanding/memory/embedders';
import { hashEmbedder as oldHash, cosine as oldCos } from '../../../src/support-voice-agent/memory/vector';

describe('memory ports', () => {
  it('hashEmbedder is byte-identical to the legacy one', () => {
    const samples = ['Users hate the new UI', 'payment-api returning 500s', 'SUPPORT-7 status'];
    for (const s of samples) {
      expect(hashEmbedder(s)).toEqual(oldHash(s));
    }
  });

  it('cosine is byte-identical to the legacy one', () => {
    const a = oldHash('a');
    const b = oldHash('b');
    expect(cosine(a, b)).toBe(oldCos(a, b));
  });

  it('hashEmbedder produces a normalized 256-dim vector', () => {
    const v = hashEmbedder('restart the checkout pod');
    expect(v).toHaveLength(256);
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('resolveEmbedder returns the hash embedder and throws on unknown names', () => {
    expect(resolveEmbedder('hash')('x')).toEqual(hashEmbedder('x'));
    expect(() => resolveEmbedder('nope')).toThrow(/Unknown embedder/);
  });

  it('InMemoryKeyValueStore round-trips get/set/delete with TTL expiry', async () => {
    let now = 1_000;
    const kv = new InMemoryKeyValueStore({ now: () => now });
    await kv.set('k', 'v', 500);
    expect(await kv.get('k')).toBe('v');
    now += 501;
    expect(await kv.get('k')).toBeUndefined();
    await kv.set('k2', 'v2');
    expect(await kv.delete('k2')).toBe(true);
    expect(await kv.delete('k2')).toBe(false);
  });

  it('InMemoryVectorMemory searches by cosine score', async () => {
    const mem = new InMemoryVectorMemory();
    await mem.add({ id: '1', text: 'restart the checkout pod' });
    await mem.add({ id: '2', text: 'quarterly roadmap planning' });
    const hits = await mem.search('restart checkout pod', 2, 0.05);
    expect(hits[0]!.id).toBe('1');
    expect(mem.size()).toBe(2);
  });
});

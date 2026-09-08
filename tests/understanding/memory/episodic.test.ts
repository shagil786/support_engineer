import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodicMemory } from '../../../src/understanding/memory/episodic';
import { InMemoryVectorMemory, cosine } from '../../../src/understanding/memory/vector';
import type { MemoryRecord } from '../../../src/understanding/memory/vector';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epi-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cosine (the score under every vector search)', () => {
  it('refuses mismatched dimensions instead of silently zero-padding into garbage', () => {
    // The old behavior: cosine([1,2], [1,2,3]) iterated only over a.length,
    // dropping b's extra component — a plausible-looking but wrong score.
    // Every vector search in the pipeline routes through this function, so
    // a mismatch must throw, not approximate.
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dim/i);
    expect(() => cosine([1, 2, 3], [1, 2])).toThrow(/dim/i);
  });

  it('keeps exact-length scoring identical', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 1], [1, 1])).toBeCloseTo(2, 6); // unnormalized dot
  });
});

describe('EpisodicMemory', () => {
  describe('durable per-meeting scope (perMeetingPath)', () => {
    const mem = (i: number): MemoryRecord => ({ id: `m${i}`, text: `checkout pod unstable warning ${i}`, metadata: {} });

    it('meeting memories survive a restart', async () => {
      const path = join(dir, 'meetings.json');
      const a = new EpisodicMemory({ perMeetingPath: path, now: () => 1_000 });
      await a.record('perMeeting', mem(1), { meetingId: 'mtg-1' });
      const b = new EpisodicMemory({ perMeetingPath: path, now: () => 1_000 });
      const hits = await b.recall('perMeeting', 'checkout pod unstable', 3);
      expect(hits.length).toBe(1);
      expect(hits[0]!.id).toBe('m1');
    });

    it('TTL expiry survives restart (expired entries are dropped on load-path recall)', async () => {
      const path = join(dir, 'meetings-ttl.json');
      const a = new EpisodicMemory({ perMeetingPath: path, now: () => 1_000 });
      await a.record('perMeeting', mem(1), { meetingId: 'mtg-1' });
      // A fresh process at now=31 days: the record is past the 30-day TTL.
      const b = new EpisodicMemory({ perMeetingPath: path, now: () => 1_000 + 31 * 24 * 3600_000 });
      const hits = await b.recall('perMeeting', 'checkout pod unstable', 3);
      expect(hits.length).toBe(0);
      // And the drop is persisted, not just filtered.
      const c = new EpisodicMemory({ perMeetingPath: path, now: () => 1_000 + 31 * 24 * 3600_000 });
      expect(c.perMeetingSize()).toBe(0);
    });

    it('purgeMeeting persists across restarts', async () => {
      const path = join(dir, 'meetings-purge.json');
      const a = new EpisodicMemory({ perMeetingPath: path, now: () => 1_000 });
      await a.record('perMeeting', mem(1), { meetingId: 'mtg-1' });
      await a.purgeMeeting('mtg-1');
      const b = new EpisodicMemory({ perMeetingPath: path, now: () => 1_000 });
      expect(b.perMeetingSize()).toBe(0);
    });

    it('default (no path) stays in-memory — nothing written', async () => {
      const a = new EpisodicMemory({ now: () => 1_000 });
      await a.record('perMeeting', mem(1), { meetingId: 'mtg-1' });
      const b = new EpisodicMemory({ now: () => 1_000 });
      expect(b.perMeetingSize()).toBe(0);
    });
  });

  it('records and recalls from a single scope', async () => {
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory() });
    await mem.record('cross', { id: '1', text: 'restart-checkout-pod restarts the checkout pod', metadata: { kind: 'procedure' } });
    const hits = await mem.recall('cross', 'how do I restart checkout', 3, 0.05);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('1');
  });

  it('isolates per-meeting scope from cross-meeting scope', async () => {
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory(), perMeeting: new InMemoryVectorMemory() });
    await mem.record('perMeeting', { id: 'm1', text: 'transient note', metadata: { meetingId: 'meeting-1' } }, { meetingId: 'meeting-1' });
    const perHits = await mem.recall('perMeeting', 'transient note', 3, 0.05);
    const crossHits = await mem.recall('cross', 'transient note', 3, 0.05);
    expect(perHits.length).toBe(1);
    expect(crossHits.length).toBe(0);
  });

  it('purges a single meeting scope only', async () => {
    const per = new InMemoryVectorMemory();
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory(), perMeeting: per });
    await mem.record('perMeeting', { id: 'a', text: 'note a' }, { meetingId: 'meeting-1' });
    await mem.record('perMeeting', { id: 'b', text: 'note b' }, { meetingId: 'meeting-2' });
    await mem.purgeMeeting('meeting-1');
    expect(per.size()).toBe(1);
  });

  it('expires per-meeting records after the TTL', async () => {
    let now = 1_000_000;
    const mem = new EpisodicMemory({
      cross: new InMemoryVectorMemory(),
      perMeeting: new InMemoryVectorMemory(),
      perMeetingTtlMs: 1_000,
      now: () => now,
    });
    await mem.record('perMeeting', { id: 'e1', text: 'fresh note' }, { meetingId: 'meeting-1' });
    expect((await mem.recall('perMeeting', 'fresh note', 3, 0.05)).length).toBe(1);
    now += 1_001;
    expect((await mem.recall('perMeeting', 'fresh note', 3, 0.05)).length).toBe(0);
  });
});

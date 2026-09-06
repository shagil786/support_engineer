import { describe, it, expect } from 'vitest';
import { EpisodicMemory } from '../../../src/understanding/memory/episodic';
import { InMemoryVectorMemory } from '../../../src/understanding/memory/vector';

describe('EpisodicMemory', () => {
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

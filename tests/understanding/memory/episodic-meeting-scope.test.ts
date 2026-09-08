import { describe, it, expect } from 'vitest';
import { EpisodicMemory } from '../../../src/understanding/memory/episodic';
import { InMemoryVectorMemory } from '../../../src/understanding/memory/vector';
import type { MemoryRecord } from '../../../src/understanding/memory/vector';

const rec = (id: string, text: string, meetingId: string): MemoryRecord => ({
  id,
  text,
  metadata: { meetingId },
});

describe('EpisodicMemory per-meeting filtering', () => {
  it('recall(scope, query, {meetingId}) returns only that meeting\'s records', async () => {
    const pm = new InMemoryVectorMemory();
    const em = new EpisodicMemory({ perMeeting: pm });
    await em.record('perMeeting', rec('a', 'checkout is down', 'meeting:U-A'), { meetingId: 'meeting:U-A' });
    await em.record('perMeeting', rec('b', 'payments latency spiked', 'meeting:U-B'), { meetingId: 'meeting:U-B' });

    const hits = await em.recall('perMeeting', 'checkout down', 5, 0, { meetingId: 'meeting:U-A' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.id !== 'b')).toBe(true);
    expect(hits.some((h) => h.id === 'a')).toBe(true);
  });

  it('the other meeting\'s records never leak across a meeting boundary', async () => {
    const pm = new InMemoryVectorMemory();
    const em = new EpisodicMemory({ perMeeting: pm });
    await em.record('perMeeting', rec('a', 'secret deploy key rotated', 'meeting:U-A'), { meetingId: 'meeting:U-A' });
    await em.record('perMeeting', rec('b', 'totally unrelated text about kubernetes', 'meeting:U-B'), { meetingId: 'meeting:U-B' });

    const hits = await em.recall('perMeeting', 'secret deploy key rotated', 5, 0, { meetingId: 'meeting:U-B' });
    expect(hits.some((h) => h.id === 'a')).toBe(false);
  });

  it('without a filter, recall spans all meetings (legacy behavior preserved)', async () => {
    const pm = new InMemoryVectorMemory();
    const em = new EpisodicMemory({ perMeeting: pm });
    await em.record('perMeeting', rec('a', 'checkout is down', 'meeting:U-A'), { meetingId: 'meeting:U-A' });
    await em.record('perMeeting', rec('b', 'payments latency spiked', 'meeting:U-B'), { meetingId: 'meeting:U-B' });

    const hits = await em.recall('perMeeting', 'checkout down', 5, 0);
    expect(hits.some((h) => h.id === 'a')).toBe(true);
  });

  it('records whose stamp predates the filter still match by meetingId (back-compat)', async () => {
    const pm = new InMemoryVectorMemory();
    const em = new EpisodicMemory({ perMeeting: pm });
    // Simulate a record written by the old pipeline path (metadata only).
    await pm.add(rec('old', 'legacy meeting note', 'meeting:U-A'));

    const hits = await em.recall('perMeeting', 'legacy meeting note', 5, 0, { meetingId: 'meeting:U-A' });
    expect(hits.some((h) => h.id === 'old')).toBe(true);
  });
});

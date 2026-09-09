import { describe, it, expect } from 'vitest';
import { InMemoryKeyValueStore } from '../src/support-voice-agent/memory/store.ts';
import { InMemoryVectorMemory, hashEmbedder, cosine } from '../src/understanding/memory/vector.ts';
import { MeetingNotes } from '../src/meeting/notes';
import type { MeetingSummaryData } from '../src/index';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('InMemoryKeyValueStore', () => {
  it('get/set/delete round-trips and honors TTL', async () => {
    let clock = 1000;
    const kv = new InMemoryKeyValueStore({ now: () => clock });
    await kv.set('k', 'v');
    expect(await kv.get('k')).toBe('v');
    await kv.set('t', 'x', 500);
    clock = 1400;
    expect(await kv.get('t')).toBe('x');
    clock = 1600;
    expect(await kv.get('t')).toBeUndefined(); // expired
    expect(await kv.delete('k')).toBe(true);
    expect(await kv.get('k')).toBeUndefined();
  });
});

describe('InMemoryVectorMemory (RAG)', () => {
  it('hash embedding is deterministic and normalized', () => {
    const a = hashEmbedder('restart the checkout pod after the deploy');
    const b = hashEmbedder('restart the checkout pod after the deploy');
    expect(a).toEqual(b);
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it('retrieves the most relevant record', async () => {
    const mem = new InMemoryVectorMemory();
    await mem.add({ id: 'r1', text: '[runbook] restart the checkout pod when payments time out after deploy' });
    await mem.add({ id: 'r2', text: '[feedback] users hate the new dark mode colors' });
    await mem.add({ id: 'r3', text: '[alert] P1 checkout latency spike' });
    const hits = await mem.search('payments are timing out after the deploy, should I restart checkout?', 1);
    expect(hits[0]?.id).toBe('r1');
  });

  it('empty store returns no hits', async () => {
    const mem = new InMemoryVectorMemory();
    expect(await mem.search('anything')).toEqual([]);
  });

  it('cosine refuses mismatched dimensions instead of silently zero-padding (parity with the pipeline twin)', () => {
    // The legacy agent's cosine was the last silent zero-padding twin of the
    // bug fixed in the understanding layer. It cannot mismatch today (single
    // in-memory embedder), but a known-silent twin of a fixed bug is a trap:
    // anyone reusing this module elsewhere inherits the garbage-score mode.
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dim/i);
    expect(() => cosine([1, 2, 3], [1, 2])).toThrow(/dim/i);
  });
});

describe('MeetingNotes (summary state owner)', () => {
  function makeNotes() {
    const kv = new InMemoryKeyValueStore();
    const notes = new MeetingNotes({ kv, now: () => 1_000_000 });
    return { notes, kv };
  }

  it('collects feedback, participants, and jira changes from any stage', () => {
    const { notes } = makeNotes();
    notes.recordUtterance('U1', 'Users hate the new onboarding flow');
    notes.recordUtterance('U2', 'yeah, agreed');
    notes.addFeedback({ at: 1_000_000, speakerId: 'U1', original: 'Users hate the new onboarding flow', paraphrase: 'The users hate the new onboarding flow.', jiraKey: 'SUP-7' });
    notes.recordJiraChange('created', 'SUP-7', 'Bug filed from verbal feedback');
    const s = notes.finishMeeting({ title: 'Test war room' });
    expect(s.participants).toEqual(['U1', 'U2']);
    expect(s.feedback).toHaveLength(1);
    expect(s.jiraChanges).toHaveLength(1);
    expect(s.feedback[0]?.jiraKey).toBe('SUP-7');
  });

  it('persists the meeting summary to the KV store', async () => {
    const { notes, kv } = makeNotes();
    notes.recordUtterance('U1', 'Users hate the new onboarding flow');
    notes.finishMeeting();
    await new Promise((r) => setTimeout(r, 0));
    const stored = await kv.get('summary:1000000');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string) as MeetingSummaryData).toHaveProperty('feedback');
  });
});

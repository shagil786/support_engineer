/**
 * MeetingNotes — direct unit pins for the summary-state owner. The pipeline
 * tests drive it end-to-end; these pin the edges an operator would notice:
 * blank utterances, participant dedup, spoken counting, summary option
 * overrides, and the KV persist contract — including its failure tolerance
 * (a broken KV must never lose the in-memory summary).
 */
import { describe, it, expect, vi } from 'vitest';
import { MeetingNotes } from '../../src/meeting/notes';
import type { MeetingSummaryData } from '../../src/support-voice-agent/types';
import type { KeyValueStore } from '../../src/support-voice-agent/memory/store';

const NOW = 1_000_000;

function rejectingKv(): KeyValueStore {
  return {
    get: async () => undefined,
    set: async () => {
      throw new Error('kv unavailable');
    },
    delete: async () => false,
  };
}

describe('MeetingNotes (direct unit pins)', () => {
  it('ignores blank utterances — a whitespace-only line never creates a participant', () => {
    const notes = new MeetingNotes({ now: () => NOW });
    notes.recordUtterance('U1', '   ');
    notes.recordUtterance('U1', '\n\t');
    expect(notes.finishMeeting().participants).toEqual([]);
  });

  it('dedups participants in first-seen order', () => {
    const notes = new MeetingNotes({ now: () => NOW });
    notes.recordUtterance('U2', 'second first');
    notes.recordUtterance('U1', 'first word');
    notes.recordUtterance('U2', 'again');
    notes.recordUtterance('U3', 'tail');
    expect(notes.finishMeeting().participants).toEqual(['U2', 'U1', 'U3']);
  });

  it('countSpoken defaults to one and accepts explicit counts', () => {
    const notes = new MeetingNotes({ now: () => NOW });
    notes.countSpoken();
    notes.countSpoken(3);
    expect(notes.finishMeeting().spokenResponseCount).toBe(4);
  });

  it('fills the summary defaults: id from the END clock, standup title, constructor startedAt', () => {
    let now = NOW;
    const notes = new MeetingNotes({ now: () => now });
    now += 5_000; // the meeting ran for 5s after construction
    const s = notes.finishMeeting();
    // quirk worth pinning: the default id stamps the FINISH time, not startedAt
    expect(s.meetingId).toBe(`meeting-${NOW + 5_000}`);
    expect(s.title).toBe('Support standup');
    expect(s.startedAt).toBe(NOW);
    expect(s.endedAt).toBe(NOW + 5_000);
  });

  it('honors explicit meetingId / title / startedAt overrides', () => {
    const notes = new MeetingNotes({ now: () => NOW });
    const s = notes.finishMeeting({ meetingId: 'war-room-42', title: 'Incident bridge', startedAt: NOW - 60_000 });
    expect(s.meetingId).toBe('war-room-42');
    expect(s.title).toBe('Incident bridge');
    expect(s.startedAt).toBe(NOW - 60_000);
    expect(s.endedAt).toBe(NOW);
  });

  it('records jira changes with the injected clock and returns the stored shape', () => {
    const notes = new MeetingNotes({ now: () => NOW });
    const change = notes.recordJiraChange('transitioned', 'SUP-7', 'moved to In Progress', NOW - 1_000);
    expect(change).toEqual({ type: 'transitioned', issueKey: 'SUP-7', detail: 'moved to In Progress', at: NOW - 1_000 });
    expect(notes.finishMeeting().jiraChanges).toEqual([change]);
  });

  it('carries concerns and alerts into the summary', () => {
    const notes = new MeetingNotes({ now: () => NOW });
    notes.addConcern({ at: NOW, speakerId: 'U1', text: 'checkout feels slow since the deploy' });
    notes.addAlert({ severity: 'P1', source: 'cloudwatch', summary: '5xx spike on checkout', ts: NOW });
    const s = notes.finishMeeting();
    expect(s.concerns).toHaveLength(1);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]?.severity).toBe('P1');
  });

  it('persists under summary:<startedAt> using the OVERRIDDEN startedAt', async () => {
    const stored = new Map<string, string>();
    const kv: KeyValueStore = {
      get: async (k) => stored.get(k),
      set: async (k, v) => void stored.set(k, v),
      delete: async () => false,
    };
    const notes = new MeetingNotes({ kv, now: () => NOW });
    notes.finishMeeting({ startedAt: NOW - 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(stored.has(`summary:${NOW - 60_000}`)).toBe(true);
  });

  it('a failing KV never loses the summary — finishMeeting still returns the data, failure is only logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const notes = new MeetingNotes({ kv: rejectingKv(), now: () => NOW });
      notes.recordUtterance('U1', 'still here');
      const s = notes.finishMeeting();
      expect(s.participants).toEqual(['U1']); // in-memory summary unaffected
      await new Promise((r) => setTimeout(r, 0)); // let the async persist rejection land
      expect(errSpy).toHaveBeenCalledWith('Summary persist failed: kv unavailable');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('static render produces the shareable text (title and spoken count included)', () => {
    const data: MeetingSummaryData = {
      meetingId: 'm-1',
      title: 'War room',
      startedAt: NOW,
      endedAt: NOW + 1_000,
      participants: ['U1'],
      feedback: [],
      concerns: [],
      jiraChanges: [],
      alerts: [],
      spokenResponseCount: 2,
    };
    const text = MeetingNotes.render(data);
    expect(text).toContain('War room');
    expect(text).toContain('2 time(s)');
  });
});

/**
 * Episodic memory facade (spec §4.1). Two scopes:
 *  - perMeeting: TTL-bounded (default 30 days), keyed by meetingId.
 *  - cross:      persistent, holds reusable procedures.
 *
 * Per-meeting records are stamped with `{ meetingId, recordedAt }` metadata
 * so purges and TTL expiry are real, not stubs.
 */
import type { MemoryRecord, SearchHit, Embedder } from './vector.js';
import { InMemoryVectorMemory } from './vector.js';

export type EpisodicScope = 'perMeeting' | 'cross';

export interface RecordOptions {
  meetingId?: string;
}

export interface EpisodicMemoryOptions {
  perMeeting?: import('./vector.js').VectorMemory;
  cross?: import('./vector.js').VectorMemory;
  perMeetingTtlMs?: number;
  embedder?: Embedder;
  now?: () => number;
}

interface MeetingStamp {
  meetingId: string;
  recordedAt: number;
}

const MEETING_META = '__meeting__';

export class EpisodicMemory {
  private readonly perMeeting: import('./vector.js').VectorMemory;
  private readonly cross: import('./vector.js').VectorMemory;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: EpisodicMemoryOptions = {}) {
    this.perMeeting = opts.perMeeting ?? new InMemoryVectorMemory({ embedder: opts.embedder });
    this.cross = opts.cross ?? new InMemoryVectorMemory({ embedder: opts.embedder });
    this.ttlMs = opts.perMeetingTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  async record(scope: EpisodicScope, rec: MemoryRecord, opts: RecordOptions = {}): Promise<void> {
    if (scope === 'cross') {
      await this.cross.add(rec);
      return;
    }
    const stamp: MeetingStamp = { meetingId: opts.meetingId ?? 'unassigned', recordedAt: this.now() };
    await this.perMeeting.add({ ...rec, metadata: { ...rec.metadata, [MEETING_META]: stamp } });
  }

  async recall(scope: EpisodicScope, query: string, topK = 3, minScore = 0.05): Promise<SearchHit[]> {
    if (scope === 'cross') {
      return this.cross.search(query, topK, minScore);
    }
    const cutoff = this.now() - this.ttlMs;
    const expired = (r: MemoryRecord) => {
      const stamp = r.metadata?.[MEETING_META] as MeetingStamp | undefined;
      return stamp !== undefined && stamp.recordedAt <= cutoff;
    };
    await this.perMeeting.purge(expired);
    return this.perMeeting.search(query, topK, minScore);
  }

  /** Drop every per-meeting record belonging to `meetingId`. */
  async purgeMeeting(meetingId: string): Promise<number> {
    return this.perMeeting.purge((r) => {
      const stamp = r.metadata?.[MEETING_META] as MeetingStamp | undefined;
      return stamp?.meetingId === meetingId;
    });
  }

  /** Drop cross-scope records matching a predicate (e.g. retiring a learned
   *  procedure). Returns how many were removed. */
  async purgeCross(predicate: (r: import('./vector.js').MemoryRecord) => boolean): Promise<number> {
    return this.cross.purge(predicate);
  }

  size(scope: EpisodicScope): number {
    return scope === 'cross' ? this.cross.size() : this.perMeeting.size();
  }
}

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
import { FileBackedVectorMemory } from './file-backed.js';

export type EpisodicScope = 'perMeeting' | 'cross';

export interface RecordOptions {
  meetingId?: string;
}

/** Optional meeting scoping for recall: hits are restricted to records
 *  stamped with this meetingId. Absent → all meetings (legacy behavior). */
export interface RecallOptions {
  meetingId?: string;
}

export interface EpisodicMemoryOptions {
  perMeeting?: import('./vector.js').VectorMemory;
  cross?: import('./vector.js').VectorMemory;
  /** File path for durable cross-scope storage (learned procedures survive
   *  restarts). Ignored when an explicit `cross` store is provided. When
   *  absent, cross scope is in-memory (per-process). */
  crossPath?: string;
  /** File path for durable per-meeting storage (meeting context survives
   *  restarts). TTL expiry and purgeMeeting() persist like any other
   *  mutation. When absent, per-meeting scope is in-memory (per-process) —
   *  the historical default. */
  perMeetingPath?: string;
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

  /** Re-embed the durable cross-scope store under the configured embedder
   *  (the recovery path for the drift guard's MODEL/DIMENSION MISMATCH).
   *  Returns the number of records re-embedded; 0 for in-memory stores. */
  async reindexCross(): Promise<number> {
    const fb = this.cross as Partial<import('./file-backed.js').FileBackedVectorMemory>;
    return typeof fb.reindex === 'function' ? fb.reindex() : 0;
  }

  /** Resolves once the durable cross store's boot compatibility check has
   *  settled (in-memory stores resolve immediately — nothing persisted to
   *  mismatch against). Readiness surfaces await this. */
  async whenBootChecked(): Promise<void> {
    const fb = this.cross as Partial<import('./file-backed.js').FileBackedVectorMemory>;
    if (typeof fb.whenBootChecked === 'function') await fb.whenBootChecked();
  }
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: EpisodicMemoryOptions = {}) {
    this.perMeeting =
      opts.perMeeting ??
      (opts.perMeetingPath
        ? new FileBackedVectorMemory({
            path: opts.perMeetingPath,
            ...(opts.embedder ? { embedder: opts.embedder } : {}),
          })
        : new InMemoryVectorMemory({ embedder: opts.embedder }));
    this.cross =
      opts.cross ??
      (opts.crossPath
        ? new FileBackedVectorMemory({ path: opts.crossPath, embedder: opts.embedder })
        : new InMemoryVectorMemory({ embedder: opts.embedder }));
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

  async recall(
    scope: EpisodicScope,
    query: string,
    topK = 3,
    minScore = 0.05,
    filter?: RecallOptions,
  ): Promise<SearchHit[]> {
    if (scope === 'cross') {
      return this.cross.search(query, topK, minScore);
    }
    const cutoff = this.now() - this.ttlMs;
    const expired = (r: MemoryRecord) => {
      const stamp = r.metadata?.[MEETING_META] as MeetingStamp | undefined;
      return stamp !== undefined && stamp.recordedAt <= cutoff;
    };
    await this.perMeeting.purge(expired);
    if (filter?.meetingId === undefined) {
      return this.perMeeting.search(query, topK, minScore);
    }
    // Meeting-scoped recall: search wide, then keep only this meeting's
    // records. Records whose stamp predates the filter still match by
    // meetingId, so stores written before this filter existed stay readable.
    const wide = await this.perMeeting.search(query, topK * 4, minScore);
    return wide
      .filter((hit) => {
        const stamp = hit.metadata?.[MEETING_META] as MeetingStamp | undefined;
        return stamp?.meetingId === filter.meetingId || hit.metadata?.meetingId === filter.meetingId;
      })
      .slice(0, topK);
  }

  /** Number of live per-meeting records (ops/readiness surfaces; test pinning). */
  perMeetingSize(): number {
    return this.perMeeting.size();
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

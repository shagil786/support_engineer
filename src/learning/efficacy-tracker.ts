/**
 * EfficacyTracker — the measurement half of the learning loop (§7.4).
 *
 * Aggregates `agent_outcome` events that carry the Supervisor's `stats`
 * (source, hops, toolCalls, wallClockMs, procedureId?, fallbackFrom?) into a
 * per-procedure + pipeline-baseline snapshot, persisted to `statsPath` for
 * cron inspection. `applyFeedback()` then folds the live evidence back into
 * each stored ProcedureSpec's successRate — blended with the extraction-time
 * evidence, never replacing it — and retires procedures whose blended rate
 * falls below `minLiveSuccessRate` (they stop being matched; the dance
 * serves those requests again).
 *
 * Like SuggestionQueue: a cron-facing scanner that tolerates malformed data
 * and never mutates policy. Reads/writes only episodic memory and the event log.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EventLog } from '../event-log/log.js';
import type { EpisodicMemory } from '../understanding/memory/episodic.js';
import type { ProcedureSpec } from './knowledge-extractor.js';

const ProcedureSpecSchemaShape = {
  id: 'string',
  trigger: 'string',
  steps: 'array',
  successRate: 'number',
  sampleSize: 'number',
} as const;

function isProcedureSpec(x: unknown): x is ProcedureSpec {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['trigger'] === 'string' &&
    Array.isArray(o['steps']) &&
    typeof o['successRate'] === 'number' &&
    typeof o['sampleSize'] === 'number' &&
    Object.keys(ProcedureSpecSchemaShape).every((k) => k in o)
  );
}

/** The Supervisor's additive stats on agent_outcome events. */
interface OutcomeStats {
  source: 'pipeline' | 'procedure';
  hops: number;
  toolCalls: number;
  wallClockMs: number;
  procedureId?: string;
  fallbackFrom?: string;
}

function parseStats(x: unknown): OutcomeStats | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  const o = x as Record<string, unknown>;
  if (o['source'] !== 'pipeline' && o['source'] !== 'procedure') return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const hops = num(o['hops']);
  const toolCalls = num(o['toolCalls']);
  const wallClockMs = num(o['wallClockMs']);
  if (hops === undefined || toolCalls === undefined || wallClockMs === undefined) return undefined;
  return {
    source: o['source'],
    hops,
    toolCalls,
    wallClockMs,
    procedureId: typeof o['procedureId'] === 'string' ? o['procedureId'] : undefined,
    fallbackFrom: typeof o['fallbackFrom'] === 'string' ? o['fallbackFrom'] : undefined,
  };
}

export interface ProcedureEfficacy {
  procedureId: string;
  served: number;
  okCount: number;
  avgHops: number;
  avgToolCalls: number;
  avgWallClockMs: number;
  /** Live success rate of this procedure since the last feedback application. */
  liveSuccessRate: number;
}

export interface EfficacySnapshot {
  procedures: ProcedureEfficacy[];
  pipeline: {
    served: number;
    okCount: number;
    avgHops: number;
    avgToolCalls: number;
    avgWallClockMs: number;
    /** Pipeline requests that attempted (and abandoned) a procedure. */
    fallbacks: number;
  };
  observedEvents: number;
  /** Ids retired by the last applyFeedback(). */
  retiredIds: string[];
}

export interface EfficacyTrackerOptions {
  eventLog: EventLog;
  episodic: EpisodicMemory;
  /** Where the snapshot JSON is persisted (best-effort). */
  statsPath?: string;
  /** Blended success rate below which a procedure is retired (default 0.9). */
  minLiveSuccessRate?: number;
  now?: () => number;
}

export class EfficacyTracker {
  private readonly eventLog: EventLog;
  private readonly episodic: EpisodicMemory;
  private readonly statsPath?: string;
  private readonly minLiveSuccessRate: number;
  private readonly now: () => number;
  private readonly perProcedure = new Map<string, { served: number; ok: number; hops: number; calls: number; ms: number }>();
  private readonly pipeline = { served: 0, ok: 0, hops: 0, calls: 0, ms: 0, fallbacks: 0 };
  private observedEvents = 0;
  private retiredIds: string[] = [];
  /** agent_outcome correlationIds already counted. The event log's query API
   *  is time-based with no offset, so dedupe is by correlationId (the
   *  supervisor emits exactly one outcome event per request). A fresh tracker
   *  instance re-observes history — its aggregates are per-process by design. */
  private readonly consumed = new Set<string>();

  constructor(opts: EfficacyTrackerOptions) {
    this.eventLog = opts.eventLog;
    this.episodic = opts.episodic;
    this.statsPath = opts.statsPath;
    this.minLiveSuccessRate = Math.min(1, Math.max(0, opts.minLiveSuccessRate ?? 0.9));
    this.now = opts.now ?? Date.now;
  }

  /** Consume all stats-carrying agent_outcome events not yet seen. */
  async scan(): Promise<{ observed: number }> {
    for await (const e of this.eventLog.query({ kind: 'agent_outcome' })) {
      if (e.kind !== 'agent_outcome') continue;
      if (this.consumed.has(e.correlationId)) continue;
      const stats = parseStats((e as unknown as { stats?: unknown }).stats);
      if (!stats) continue; // legacy event without stats
      this.consumed.add(e.correlationId);
      this.observedEvents++;
      if (stats.source === 'procedure' && stats.procedureId) {
        const b = this.perProcedure.get(stats.procedureId) ?? { served: 0, ok: 0, hops: 0, calls: 0, ms: 0 };
        b.served++;
        b.hops += stats.hops;
        b.calls += stats.toolCalls;
        b.ms += stats.wallClockMs;
        if (e.finalResult.ok) b.ok++;
        this.perProcedure.set(stats.procedureId, b);
      } else {
        this.pipeline.served++;
        this.pipeline.hops += stats.hops;
        this.pipeline.calls += stats.toolCalls;
        this.pipeline.ms += stats.wallClockMs;
        if (e.finalResult.ok) this.pipeline.ok++;
        if (stats.fallbackFrom) this.pipeline.fallbacks++;
      }
    }
    await this.persistSnapshot();
    return { observed: this.observedEvents };
  }

  /** Fold live outcomes back into stored ProcedureSpecs. A procedure whose
   *  blended success rate falls below `minLiveSuccessRate` is retired from
   *  cross-meeting memory (the ProcedureLibrary stops matching it). */
  async applyFeedback(): Promise<{ updated: number; retired: number }> {
    const hits = await this.episodic.recall('cross', 'procedure:', 100, 0);
    const stored = new Map<string, ProcedureSpec>();
    for (const h of hits) {
      const raw = (h.metadata as { procedure?: unknown } | undefined)?.procedure;
      if (isProcedureSpec(raw)) stored.set(raw.id, raw);
    }

    let updated = 0;
    const retired: string[] = [];
    for (const [id, b] of this.perProcedure) {
      const spec = stored.get(id);
      if (!spec) continue; // stale stats for a deleted spec — not fatal
      const extractedWeight = Math.max(0, spec.sampleSize);
      const extractedSuccesses = extractedWeight * spec.successRate;
      const blendedRate = (extractedSuccesses + b.ok) / (extractedWeight + b.served);
      if (blendedRate < this.minLiveSuccessRate) {
        await this.episodic.purgeCross((r) => r.id === id);
        retired.push(id);
        continue;
      }
      const next: ProcedureSpec = {
        ...spec,
        successRate: blendedRate,
        sampleSize: extractedWeight + b.served,
      };
      await this.episodic.record('cross', {
        id: next.id,
        text: 'procedure: ' + next.trigger,
        metadata: { procedure: next },
      });
      updated++;
    }
    for (const id of retired) this.perProcedure.delete(id);
    this.retiredIds = retired;
    await this.persistSnapshot();
    return { updated, retired: retired.length };
  }

  snapshot(): EfficacySnapshot {
    const proc = (b: { served: number; ok: number; hops: number; calls: number; ms: number }, procedureId: string): ProcedureEfficacy => ({
      procedureId,
      served: b.served,
      okCount: b.ok,
      avgHops: b.served ? b.hops / b.served : 0,
      avgToolCalls: b.served ? b.calls / b.served : 0,
      avgWallClockMs: b.served ? b.ms / b.served : 0,
      liveSuccessRate: b.served ? b.ok / b.served : 0,
    });
    return {
      procedures: [...this.perProcedure.entries()].map(([id, b]) => proc(b, id)),
      pipeline: {
        served: this.pipeline.served,
        okCount: this.pipeline.ok,
        avgHops: this.pipeline.served ? this.pipeline.hops / this.pipeline.served : 0,
        avgToolCalls: this.pipeline.served ? this.pipeline.calls / this.pipeline.served : 0,
        avgWallClockMs: this.pipeline.served ? this.pipeline.ms / this.pipeline.served : 0,
        fallbacks: this.pipeline.fallbacks,
      },
      observedEvents: this.observedEvents,
      retiredIds: [...this.retiredIds],
    };
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.statsPath) return;
    try {
      await mkdir(dirname(this.statsPath), { recursive: true });
      await writeFile(this.statsPath, JSON.stringify(this.snapshot(), null, 2), 'utf8');
    } catch {
      // best-effort observability — never fatal
    }
  }
}

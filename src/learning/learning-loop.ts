/**
 * LearningLoop — the cron bootstrap that turns the learning layer's parts
 * into an operating system (spec §7.4 wiring).
 *
 * One tick runs every stage in dependency order:
 *
 *   1. KnowledgeExtractor.extract()   outcomes → ProcedureSpecs (durable)
 *   2. EfficacyTracker.scan()         agent_outcome.stats → aggregates
 *   3. EfficacyTracker.applyFeedback() blend + retire procedures
 *   4. ProcedureLibrary.refresh()     supervisor sees the new state
 *
 * Every stage is individually failure-tolerant: an error is collected into
 * the tick result and the remaining stages still run — a broken event-log
 * backend must not stop extraction. The constructed library is wired to the
 * durable crossPath, so procedures (and retirements) survive restarts, and
 * it is handed to the SupervisorAgent as `procedures` by the composition
 * root (see scripts/learning-cron.ts).
 *
 * Scheduling is setInterval-based with an in-tick reentrancy guard (a slow
 * extraction never overlaps itself) and idempotent start() (replaces, never
 * stacks intervals).
 */
import type { EventLog } from '../event-log/log.js';
import { EpisodicMemory } from '../understanding/memory/episodic.js';
import { KnowledgeExtractor } from './knowledge-extractor.js';
import { EfficacyTracker } from './efficacy-tracker.js';
import { ProcedureLibrary } from '../execution/procedure-library.js';

export interface LearningLoopOptions {
  eventLog: EventLog;
  /** Directory of OutcomeRecord JSONs (OutcomeRecorder's output). */
  outcomesDir: string;
  /** Durable snapshot path for cross-scope episodic memory. Ignored when an
   *  explicit `episodic` instance is supplied (composition roots share one). */
  crossPath: string;
  /** Pre-built shared episodic memory (e.g. the platform's durable one).
   *  When omitted, a durable EpisodicMemory over `crossPath` is constructed. */
  episodic?: EpisodicMemory;
  /** Where EfficacyTracker persists its snapshot (best-effort). */
  statsPath?: string;
  /** Blended success rate below which procedures are retired. */
  minLiveSuccessRate?: number;
  /** Minimum occurrences before a sequence becomes a procedure. */
  minClusterSize?: number;
  now?: () => number;
}

export interface TickResult {
  /** Procedures newly extracted this tick. */
  extracted: number;
  /** Outcome events newly observed by the tracker. */
  observed: number;
  /** Procedures whose successRate was blended with live evidence. */
  updated: number;
  /** Procedures retired (below the live success threshold). */
  retired: number;
  /** Procedures loaded in the library after the tick. */
  librarySize: number;
  /** One entry per failed stage; the tick itself never throws. */
  errors: string[];
}

export class LearningLoop {
  /** Durable episodic memory backing every learner and the library. */
  readonly episodic: EpisodicMemory;
  readonly extractor: KnowledgeExtractor;
  readonly tracker: EfficacyTracker;
  /** The library a SupervisorAgent consumes as `procedures`. */
  readonly library: ProcedureLibrary;

  /** When true, start() ticks once immediately before scheduling. */
  runOnStart = false;

  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly now: () => number;

  constructor(opts: LearningLoopOptions) {
    this.now = opts.now ?? Date.now;
    this.episodic = opts.episodic ?? new EpisodicMemory({ crossPath: opts.crossPath, ...(opts.now ? { now: opts.now } : {}) });
    this.extractor = new KnowledgeExtractor({
      outcomesDir: opts.outcomesDir,
      episodic: this.episodic,
      ...(opts.minClusterSize !== undefined ? { minClusterSize: opts.minClusterSize } : {}),
    });
    this.tracker = new EfficacyTracker({
      eventLog: opts.eventLog,
      episodic: this.episodic,
      ...(opts.statsPath !== undefined ? { statsPath: opts.statsPath } : {}),
      ...(opts.minLiveSuccessRate !== undefined ? { minLiveSuccessRate: opts.minLiveSuccessRate } : {}),
      now: opts.now,
    });
    this.library = new ProcedureLibrary({ episodic: this.episodic });
  }

  /** Run one full learning cycle. Never throws — stage failures are
   *  collected in `errors`. */
  async tick(): Promise<TickResult> {
    if (this.ticking) {
      return { extracted: 0, observed: 0, updated: 0, retired: 0, librarySize: this.library.size(), errors: ['tick already in progress'] };
    }
    this.ticking = true;
    const errors: string[] = [];
    let extracted = 0;
    let observed = 0;
    let updated = 0;
    let retired = 0;
    try {
      try {
        extracted = (await this.extractor.extract()).length;
      } catch (e) {
        errors.push(`extract failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        observed = (await this.tracker.scan()).observed;
      } catch (e) {
        errors.push(`scan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        const fb = await this.tracker.applyFeedback();
        updated = fb.updated;
        retired = fb.retired;
      } catch (e) {
        errors.push(`feedback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        await this.library.refresh();
      } catch (e) {
        errors.push(`library refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      this.ticking = false;
    }
    return { extracted, observed, updated, retired, librarySize: this.library.size(), errors };
  }

  /** Schedule ticks every `intervalMs`. Idempotent: replaces any prior
   *  schedule. With `runOnStart`, ticks once immediately (unguarded). */
  start(intervalMs: number): void {
    this.stop();
    if (this.runOnStart) void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Re-embeds the durable cross-scope store at `crossPath` under the same
 * embedder construction the LearningLoop itself uses, and stamps the identity
 * sidecar. This is the recovery path the FileBackedVectorMemory drift guard's
 * error message points to: after an embedder swap (dimension or model), run
 * this once (learning-cron --reindex) before restarting serve — never mix
 * vector spaces.
 */
export async function reindexCrossMemory(crossPath: string): Promise<number> {
  const episodic = new EpisodicMemory({ crossPath });
  return episodic.reindexCross();
}

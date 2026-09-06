/**
 * ProcedureLibrary — runtime counterpart to the KnowledgeExtractor (§7.4).
 * Loads learned ProcedureSpecs from cross-meeting episodic memory and matches
 * incoming requests against them so the SupervisorAgent can short-circuit
 * the multi-agent dance for well-evidenced, previously-successful flows.
 *
 * Quality gates before live replay: a procedure must have been observed
 * `minSampleSize` times (default 3 — stricter than extraction's 2, because
 * replay happens on the hot path) with `minSuccessRate` (default 1.0 — only
 * perfect records replay). Matching is by leading tool: the extractor
 * clusters by tool sequence, so the sequence's tools are all a match can
 * key on — the leading one is the request's governed action.
 */
import { z } from 'zod';
import type { EpisodicMemory } from '../understanding/memory/episodic.js';
import type { ProcedureSpec, ProcedureStep } from '../learning/knowledge-extractor.js';

const ProcedureStepSchema = z.object({
  agent: z.enum(['triage', 'investigator', 'executor']),
  tool: z.string().min(1).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

const ProcedureSpecSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  steps: z.array(ProcedureStepSchema).min(1),
  successRate: z.number().min(0).max(1),
  sampleSize: z.number().int().min(1),
});

export interface ProcedureMatch {
  procedure: ProcedureSpec;
  /** The request's own action as recorded in the procedure (tool match). */
  leading: ProcedureStep;
  /** Remaining steps after the leading one, in replay order. */
  replay: ProcedureStep[];
}

export interface ProcedureLibraryOptions {
  episodic: EpisodicMemory;
  /** Minimum observations before live replay is allowed (default 3). */
  minSampleSize?: number;
  /** Minimum success rate before live replay is allowed (default 1). */
  minSuccessRate?: number;
}

export class ProcedureLibrary {
  private readonly episodic: EpisodicMemory;
  private readonly minSampleSize: number;
  private readonly minSuccessRate: number;
  private readonly procedures: ProcedureSpec[] = [];

  constructor(opts: ProcedureLibraryOptions) {
    this.episodic = opts.episodic;
    this.minSampleSize = Math.max(1, opts.minSampleSize ?? 3);
    this.minSuccessRate = Math.min(1, Math.max(0, opts.minSuccessRate ?? 1));
  }

  /** Reload procedures from cross-scope memory. A throwing memory backend
   *  leaves the library empty — callers degrade to the full agent dance. */
  async refresh(): Promise<void> {
    this.procedures.length = 0;
    let hits;
    try {
      hits = await this.episodic.recall('cross', 'procedure:', 100, 0);
    } catch {
      return;
    }
    for (const h of hits) {
      const raw = (h.metadata as { procedure?: unknown } | undefined)?.procedure;
      const parsed = ProcedureSpecSchema.safeParse(raw);
      if (parsed.success) this.procedures.push(parsed.data);
    }
  }

  size(): number {
    return this.procedures.length;
  }

  /** Best procedure whose sequence contains `actionTool`, leading the replay
   *  (the extractor's clusters key on the tool sequence; the request's own
   *  governed action must lead it). Ties break toward the larger sample. */
  async match(actionTool: string): Promise<ProcedureMatch | undefined> {
    await this.refresh();
    const candidates = this.procedures
      .filter((p) => p.sampleSize >= this.minSampleSize && p.successRate >= this.minSuccessRate)
      .map((p) => ({ p, lead: p.steps.find((s) => s.tool === actionTool) }))
      .filter((x): x is { p: ProcedureSpec; lead: ProcedureStep } => x.lead !== undefined)
      .sort((a, b) => b.p.sampleSize - a.p.sampleSize);

    const best = candidates[0];
    if (!best) return undefined;
    const idx = best.p.steps.indexOf(best.lead);
    return { procedure: best.p, leading: best.lead, replay: best.p.steps.slice(idx + 1) };
  }
}

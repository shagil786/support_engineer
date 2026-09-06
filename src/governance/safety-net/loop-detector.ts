/**
 * Per-correlation loop detector: flags runaway agents that keep issuing the
 * identical tool call. Stateful per correlationId — the Supervisor (Phase 4)
 * passes its own correlation context in; the detector owns the history.
 *
 * Deviation from the plan text: the plan's LoopDetector was stateless and
 * counted only a caller-managed array, which made check() unable to see the
 * pending call in runAll(). This version keeps per-correlation history so
 * record → check sequencing is meaningful.
 */
import type { VetoResult } from './injection.js';

export interface LoopContext {
  correlationId: string;
}

const MAX_IDENTICAL_CALLS = 3;

const keyOf = (tool: string, args: unknown): string => `${tool}::${JSON.stringify(args ?? null)}`;

export class LoopDetector {
  private readonly max: number;
  private readonly history = new Map<string, string[]>();

  constructor(maxIdenticalCalls: number = MAX_IDENTICAL_CALLS) {
    this.max = maxIdenticalCalls;
  }

  record(ctx: LoopContext, tool: string, args: unknown): void {
    const calls = this.history.get(ctx.correlationId) ?? [];
    calls.push(keyOf(tool, args));
    this.history.set(ctx.correlationId, calls);
  }

  /** True when the pending (tool, args) would be the (max+1)-th identical call. */
  check(ctx: LoopContext, tool: string, args: unknown): VetoResult {
    const key = keyOf(tool, args);
    const count = (this.history.get(ctx.correlationId) ?? []).filter((k) => k === key).length;
    if (count > this.max) {
      return { vetoed: true, reason: `loop detected: '${tool}' issued ${count} identical calls (limit ${this.max})` };
    }
    return { vetoed: false, reason: '' };
  }

  /** Drop history for a finished correlation. */
  clear(ctx: LoopContext): void {
    this.history.delete(ctx.correlationId);
  }
}

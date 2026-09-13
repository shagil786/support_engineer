/**
 * ShadowReplay (ADR-0010) — replays recorded governance traffic from the
 * event spine against a CANDIDATE policy bundle, in shadow mode: nothing is
 * audited, executed, or gated. The candidate's decisions are compared to the
 * ones the live bundle actually made (recorded on the spine), and every
 * divergence is reported.
 *
 * Why: the shipped eval scenarios (policies/eval/scenarios.yaml) are
 * hand-written and only cover what we thought to pin. Shadow replay covers
 * what actually happened — real envelopes, real actions, real volume. A
 * candidate bundle that quietly default-denies a read-only tool that traffic
 * exercises daily passes the handwritten suite while breaking production;
 * it cannot pass the replayer.
 *
 * Replay contract:
 *  - Only `governance` events WITH a recorded `action` replay. Legacy events
 *    (pre-2026-09-13) carry no action and are counted, never fatal.
 *  - The FIRST governance event per correlationId is the live policy's
 *    decision. A second event on the same correlationId is the dispatch's
 *    blast-escalation re-audit — platform logic layered on top of policy,
 *    so replaying it would double-count the same traffic.
 *  - Replay re-runs ONLY the policy engine (candidate.evaluate). The
 *    SafetyNet, blast topology, and approval gate are deliberately out of
 *    scope: they are code or platform state, not bundle data — ADR-0010.
 *  - An empty log (or a window with no actionable events) is zero replays,
 *    not an error: a green harness must never depend on having traffic.
 */
import { z } from 'zod';
import type { EventLog, EventFilter } from '../event-log/log.js';
import type { DecisionEvent, DecisionEventOf } from '../event-log/types.js';
import type { PolicyEngine } from '../governance/policy-engine.js';

/** One recorded decision that the candidate would have decided differently. */
export interface ShadowDivergence {
  correlationId: string;
  ts: number;
  tool: string;
  /** What the live bundle decided (as recorded on the spine). */
  recorded: DecisionEventOf<'governance'>['decision']['effect'];
  /** What the candidate bundle would decide. */
  candidate: DecisionEventOf<'governance'>['decision']['effect'];
}

export interface ShadowReplayResult {
  /** Governance events inspected inside the window. */
  inspected: number;
  /** Events replayed (first-per-cid, with a recorded action). */
  replayed: number;
  /** Events skipped: legacy (no action) or non-first for their cid. */
  skipped: number;
  /** How the replay window was chosen (for the report / promotion audit). */
  window: { from?: number; to?: number; reason: string };
  divergences: ShadowDivergence[];
}

export interface ShadowReplayOptions {
  eventLog: EventLog;
  engine: PolicyEngine;
  /** Inclusive lower epoch-ms bound. Defaults to the bundle's promotedAt
   *  when available — traffic decided by OLDER bundles must not vote on the
   *  candidate. Pass an explicit window to override. */
  from?: number;
  /** Exclusive upper epoch-ms bound. Defaults to now-ish (no cap). */
  to?: number;
}

const ActionSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** Attempts to coerce an event's recorded action into a ProposedAction.
 *  Returns undefined when the event predates action emission. */
function recordedAction(event: DecisionEventOf<'governance'>): { tool: string; args: Record<string, unknown> } | undefined {
  if (event.action === undefined) return undefined;
  const parsed = ActionSchema.safeParse(event.action);
  return parsed.success ? parsed.data : undefined;
}
export class ShadowReplay {
  private readonly eventLog: EventLog;
  private readonly engine: PolicyEngine;

  constructor(opts: ShadowReplayOptions) {
    this.eventLog = opts.eventLog;
    this.engine = opts.engine;
  }

  /**
   * Replays the window (or the whole log) against the candidate engine.
   * `engine` overrides the constructor's (live) engine — the PromotionGate
   * passes its CANDIDATE engine here; standalone runs replay against the
   * live bundle itself, which must produce zero divergences by definition.
   * A query failure is a harness failure (fail-closed) — the spine is the
   * input, and silently replaying half of it would understate the risk.
   */
  async run(opts: { engine?: PolicyEngine; from?: number; to?: number; bundlePromotedAt?: number } = {}): Promise<ShadowReplayResult> {
    const from = opts.from ?? opts.bundlePromotedAt;
    const engine = opts.engine ?? this.engine;
    const filter: EventFilter = { kind: 'governance' };
    if (from !== undefined) filter.from = from;
    if (opts.to !== undefined) filter.to = opts.to;

    const window: ShadowReplayResult['window'] = {
      ...(from !== undefined ? { from } : {}),
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      reason:
        from === undefined
          ? 'full log (no window and no promotedAt)'
          : opts.from !== undefined
            ? 'explicit window'
            : 'since current bundle promotion',
    };

    const seenCids = new Set<string>();
    let inspected = 0;
    let replayed = 0;
    let skipped = 0;
    const divergences: ShadowDivergence[] = [];

    for await (const event of this.eventLog.query(filter)) {
      if (event.kind !== 'governance') continue;
      inspected++;
      if (seenCids.has(event.correlationId)) {
        // Second event on a cid = blast-escalation re-audit, not new traffic.
        skipped++;
        continue;
      }
      seenCids.add(event.correlationId);
      const action = recordedAction(event);
      if (action === undefined) {
        skipped++; // legacy event: no recorded action to replay
        continue;
      }
      replayed++;
      const candidate = engine.evaluate(event.intent, action as never);
      if (candidate.effect !== event.decision.effect) {
        divergences.push({
          correlationId: event.correlationId,
          ts: event.ts,
          tool: action.tool,
          recorded: event.decision.effect,
          candidate: candidate.effect,
        });
      }
    }

    return { inspected, replayed, skipped, window, divergences };
  }
}


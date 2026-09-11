/**
 * SuggestionQueue (spec §7.2): cron-triggered scan over OutcomeRecords.
 * v1 heuristic — counts destructive-runbook approvals; above a threshold it
 * proposes a policy change. Suggestions are ONLY proposals: they never touch
 * the PolicyStore. PromotionGate is the sole writer, and it re-evaluates
 * everything from scratch.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { correlationId } from '../event-log/correlation.js';

export interface PolicySuggestion {
  id: string;
  rationale: string;
  evidence: { outcomeIds: string[]; sampleSize: number; confidence: number };
  proposedChange:
    | { type: 'add_rule'; rule: Record<string, unknown> }
    | { type: 'modify_rule'; ruleId: string; patch: Record<string, unknown> }
    | { type: 'tighten_safety_net'; check: string }
    | { type: 'add_procedure'; procedure: Record<string, unknown> };
  /** Relaxing human oversight is never low-risk, whatever the sample size. */
  risk: 'low' | 'medium' | 'high';
  estimatedImpact: { outcomeMetric: string; expectedDelta: string };
}

export interface SuggestionQueueOptions {
  outcomesDir: string;
  destructiveApprovalsThreshold?: number;
  now?: () => number;
}

interface LoadedOutcome {
  id: string;
  approvals: unknown[];
  /** Reviewer-fail re-dances this request needed (OutcomeRecord field).
   *  Absent/malformed = 0 — unknown retry history never invents evidence. */
  reviewRetries: number;
}

/** Above this share of approval outcomes needing review retries, relaxation
 *  is withheld: a review that passes only after a re-dance is evidence the
 *  pre-grant bar is doing real work, not ceremony. */
const RETRY_LOAD_RATIO = 0.5;

export class SuggestionQueue {
  private readonly outcomesDir: string;
  private readonly threshold: number;
  private readonly now: () => number;

  constructor(opts: SuggestionQueueOptions) {
    this.outcomesDir = opts.outcomesDir;
    this.threshold = Math.max(1, opts.destructiveApprovalsThreshold ?? 5);
    this.now = opts.now ?? Date.now;
  }

  async scan(): Promise<PolicySuggestion[]> {
    let files: string[];
    try {
      files = (await readdir(this.outcomesDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return []; // no outcomes yet — nothing to learn from
    }

    const withApprovals: LoadedOutcome[] = [];
    for (const f of files) {
      let data: unknown;
      try {
        data = JSON.parse(await readFile(join(this.outcomesDir, f), 'utf8'));
      } catch {
        continue; // tolerate malformed files
      }
      const approvals = (data as { approvals?: unknown }).approvals;
      if (Array.isArray(approvals) && approvals.length > 0) {
        const rawRetries = (data as { reviewRetries?: unknown }).reviewRetries;
        const reviewRetries = typeof rawRetries === 'number' && Number.isFinite(rawRetries) && rawRetries > 0 ? rawRetries : 0;
        withApprovals.push({ id: f.replace(/\.json$/, ''), approvals, reviewRetries });
      }
    }

    const out: PolicySuggestion[] = [];
    const retried = withApprovals.filter((o) => o.reviewRetries > 0).length;
    if (withApprovals.length > 0 && retried / withApprovals.length >= RETRY_LOAD_RATIO) {
      // Reviews are repairing requests before every grant — keep the bar.
      // This is a deliberate stand-down (no suggestion), not an error.
      return [];
    }
    if (withApprovals.length >= this.threshold) {
      out.push({
        id: correlationId(this.now()),
        rationale:
          `${withApprovals.length} destructive runbook approvals observed ` +
          `(threshold ${this.threshold}) — consider whether approver_count can be relaxed for low-risk actions.`,
        evidence: {
          outcomeIds: withApprovals.map((r) => r.id),
          sampleSize: withApprovals.length,
          confidence: 0.5,
        },
        proposedChange: {
          type: 'modify_rule',
          ruleId: 'destructive_runbook_requires_admin_approval',
          patch: { approver_count: 1 },
        },
        risk: 'high',
        estimatedImpact: { outcomeMetric: 'human-approval latency', expectedDelta: '−50%' },
      });
    }
    return out;
  }
}

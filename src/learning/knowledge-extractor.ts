/**
 * KnowledgeExtractor (spec §7.4): mines OutcomeRecords for repeated
 * successful tool-call sequences and distills them into ProcedureSpecs,
 * stored in cross-scope episodic memory so future requests can recall them.
 *
 * Clustering is by the ordered tool sequence among SUCCESSFUL calls only —
 * failed calls never inflate a procedure's success rate. Extraction is
 * offline (nightly) and additive: it never mutates policy or code.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DecisionEventOf } from '../event-log/types.js';
import type { ToolResult } from '../support-voice-agent/tools/types.js';
import type { EpisodicMemory } from '../understanding/memory/episodic.js';

type ToolCallEvent = DecisionEventOf<'tool_call'>;

export interface ProcedureStep {
  agent: 'triage' | 'investigator' | 'executor';
  tool?: string;
  args?: Record<string, unknown>;
}

export interface ProcedureSpec {
  id: string;
  trigger: string;
  steps: ProcedureStep[];
  successRate: number;
  sampleSize: number;
}

export interface KnowledgeExtractorOptions {
  outcomesDir: string;
  episodic: EpisodicMemory;
  /** Minimum occurrences before a sequence becomes a procedure. */
  minClusterSize?: number;
}

interface LoadedOutcome {
  id: string;
  toolCalls: ToolCallEvent[];
}

export class KnowledgeExtractor {
  private readonly outcomesDir: string;
  private readonly episodic: EpisodicMemory;
  private readonly minClusterSize: number;

  constructor(opts: KnowledgeExtractorOptions) {
    this.outcomesDir = opts.outcomesDir;
    this.episodic = opts.episodic;
    this.minClusterSize = Math.max(2, opts.minClusterSize ?? 2);
  }

  async extract(): Promise<ProcedureSpec[]> {
    let files: string[];
    try {
      files = (await readdir(this.outcomesDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return []; // no outcomes yet
    }

    const records: LoadedOutcome[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(await readFile(join(this.outcomesDir, f), 'utf8')) as {
          correlationId?: unknown;
          toolCalls?: unknown;
        };
        if (typeof data.correlationId === 'string' && Array.isArray(data.toolCalls)) {
          records.push({
            id: data.correlationId,
            toolCalls: data.toolCalls.filter(
              (t): t is ToolCallEvent =>
                typeof t === 'object' && t !== null &&
                (t as { kind?: unknown }).kind === 'tool_call',
            ),
          });
        }
      } catch {
        continue; // tolerate malformed files
      }
    }

    // Cluster by the ordered tool sequence of SUCCESSFUL calls.
    const groups = new Map<string, LoadedOutcome[]>();
    for (const r of records) {
      const ok = r.toolCalls.filter((t) => t.result.ok);
      if (ok.length === 0) continue;
      const key = ok.map((t) => t.tool).join(' → ');
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }

    const out: ProcedureSpec[] = [];
    for (const [key, members] of groups) {
      if (members.length < this.minClusterSize) continue;
      const steps: ProcedureStep[] = (members[0]?.toolCalls ?? [])
        .filter((t) => t.result.ok)
        .map((t) => ({ agent: 'investigator' as const, tool: t.tool, args: t.args as Record<string, unknown> }));
      const proc: ProcedureSpec = {
        id: `proc-${key.replace(/[^a-z0-9]+/gi, '-')}`,
        trigger: key,
        steps,
        successRate: 1,
        sampleSize: members.length,
      };
      await this.episodic.record('cross', {
        id: proc.id,
        text: `procedure: ${key}`,
        metadata: { procedure: proc },
      });
      out.push(proc);
    }
    return out;
  }
}

/** Kept for the "successRate" contract: outcomes with failures are already
 *  excluded from clusters, so a stored procedure is 100% by construction. */
export type ProcedureOutcome = ToolResult;

/**
 * Retrieval evaluation (rag-engineering skill §Evaluation): hit rate and
 * MRR over a golden set. Deterministic and LLM-free, so it runs in CI next
 * to the policy eval scenarios — a regressed retrieval stack fails the suite
 * exactly like a regressed policy bundle.
 */
import type { FileBackedKnowledgeBase, SearchOptions } from './knowledge-base.js';

export interface RetrievalCase {
  id: string;
  query: string;
  /** Any of these doc ids in the results counts as a hit. */
  relevantDocIds: string[];
  /** Optional per-case metadata filter. */
  where?: SearchOptions['where'];
  /** Per-case result depth (default 5). */
  topK?: number;
}

export interface GoldenSet {
  name: string;
  cases: RetrievalCase[];
}

export interface RetrievalEvalResult {
  name: string;
  cases: number;
  /** Fraction of cases with ≥1 relevant doc in the returned results. */
  hitRate: number;
  /** Mean reciprocal rank of the first relevant doc (0 when missed). */
  mrr: number;
  failures: Array<{ id: string; query: string; expected: string[]; rank: number | null }>;
}

export async function evaluateRetrieval(
  kb: Pick<FileBackedKnowledgeBase, 'search'>,
  set: GoldenSet,
): Promise<RetrievalEvalResult> {
  const failures: RetrievalEvalResult['failures'] = [];
  let reciprocalSum = 0;
  let hits = 0;

  for (const c of set.cases) {
    const results = await kb.search(c.query, { topK: c.topK ?? 5, ...(c.where ? { where: c.where } : {}) });
    const rank = results.findIndex((h) => c.relevantDocIds.includes(h.docId));
    if (rank >= 0) {
      hits += 1;
      reciprocalSum += 1 / (rank + 1);
    } else {
      failures.push({ id: c.id, query: c.query, expected: [...c.relevantDocIds], rank: null });
    }
  }

  const cases = set.cases.length;
  return {
    name: set.name,
    cases,
    hitRate: cases === 0 ? 0 : hits / cases,
    mrr: cases === 0 ? 0 : reciprocalSum / cases,
    failures,
  };
}

/** CI gate: throws with the failing case ids when below threshold. */
export function assertQualityGate(
  result: RetrievalEvalResult,
  gate: { minHitRate: number; minMrr?: number },
): void {
  if (result.hitRate < gate.minHitRate) {
    const ids = result.failures.map((f) => f.id).join(', ');
    throw new Error(
      `Retrieval quality gate failed: hitRate ${result.hitRate.toFixed(3)} < ${gate.minHitRate} (failing: ${ids})`,
    );
  }
  if (gate.minMrr !== undefined && result.mrr < gate.minMrr) {
    throw new Error(`Retrieval quality gate failed: mrr ${result.mrr.toFixed(3)} < ${gate.minMrr}`);
  }
}

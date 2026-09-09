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

/** One calibrated probe: a query, the doc that should win it (and how high),
 *  or the score the TOP hit must stay below. Groups form the acceptance
 *  bands: true matches must clear the strong band; wrong winners and
 *  unrelated chatter must stay under it / under the floor. */
export interface BandCase {
  id: string;
  query: string;
  /** Doc expected to win; its measured score is compared against `min`/`max`. */
  targetDocId?: string;
  /** The measured target (or top-hit) score must be >= this. */
  min?: number;
  /** The measured target (or top-hit) score must be < this. */
  max?: number;
  /** Metadata filter for the search (the resolver scopes to `runbooks`). */
  where?: SearchOptions['where'];
}

export interface BandCalibrationResult {
  cases: number;
  /** Every case's measured score, for diagnostics. */
  measurements: Array<{ id: string; query: string; score: number | null; ok: boolean }>;
}

/** Re-measure the scoring engine's distribution on a calibration set and
 *  check each case against its expected band. This is the two-sided guard
 *  ADR-0002/ADR-0006 flag as future work: an engine change that moves the
 *  score scale (different reranker, different fusion, different embedder)
 *  fails here — before the resolver's bands mis-sort a real utterance.
 *  LLM-free and deterministic, so it runs in CI next to the golden set. */
export async function assertBandsInGap(
  kb: Pick<FileBackedKnowledgeBase, 'search'>,
  cases: BandCase[],
): Promise<BandCalibrationResult> {
  const measurements: BandCalibrationResult['measurements'] = [];
  for (const c of cases) {
    const hits = await kb.search(c.query, { topK: 3, ...(c.where ? { where: c.where } : {}) });
    const target = c.targetDocId === undefined ? hits[0] : hits.find((h) => h.docId === c.targetDocId);
    const score = target?.score ?? null;
    const ok =
      score !== null &&
      (c.min === undefined || score >= c.min) &&
      (c.max === undefined || score < c.max);
    measurements.push({ id: c.id, query: c.query, score, ok });
  }
  const failed = measurements.filter((m) => !m.ok);
  if (failed.length > 0) {
    const detail = failed
      .map((m) => `${m.id} ("${m.query}") measured ${m.score === null ? 'NO HIT' : m.score.toFixed(3)}`)
      .join('; ');
    throw new Error(
      `Runbook band calibration failed: the scoring engine's distribution no longer fits the configured bands — ${detail}. Recalibrate the resolver's acceptance bands against the new distribution before shipping.`,
    );
  }
  return { cases: cases.length, measurements };
}

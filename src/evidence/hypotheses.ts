/**
 * Hypothesis engine — ranks candidate root causes over the evidence graph.
 *
 * Deterministic scoring (no LLM): every hypothesis carries its evidence node
 * ids, its contradicting evidence, and a 0..1 confidence computed from edge
 * weights. The investigator LLM may WORD a hypothesis, but it may not invent
 * confidence — it must cite the graph.
 */
import type { EvidenceGraph } from './graph.js';

export interface HypothesisInput {
  /** Short claim, e.g. "PR #481 changed timeout handling". */
  claim: string;
  /** Node ids supporting the claim (PR node, deploy node, trace node, ...). */
  evidence: string[];
  /** Node ids contradicting the claim (a clean canary, an older deploy, ...). */
  contradicts?: string[];
  /** Optional prior (e.g. change-intel suspicion). Multiplied, never added. */
  prior?: number;
}

export interface RankedHypothesis extends HypothesisInput {
  confidence: number;
  /** How the confidence was derived — auditable, LLM-free. */
  rationale: string;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Confidence = mean(edge weight into evidence, default 0.5) × prior,
 * discounted 0.25 per contradicting node that EXISTS in the graph.
 * Contradictions referencing unknown ids are ignored (cannot contradict
 * with evidence nobody collected).
 */
export function scoreHypothesis(graph: EvidenceGraph, h: HypothesisInput): RankedHypothesis {
  const weights = h.evidence.map((id) => {
    const links = graph.neighbors(id);
    const w = links.map((l) => l.edge.weight).filter((x): x is number => typeof x === 'number');
    if (w.length === 0) return graph.get(id) ? 0.5 : 0;
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const base = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
  const realContradictions = (h.contradicts ?? []).filter((id) => graph.get(id) !== undefined);
  const discounted = base * Math.pow(0.75, realContradictions.length);
  const confidence = clamp01(discounted * (h.prior ?? 1));
  const rationale =
    `mean evidence weight ${base.toFixed(2)} over ${weights.length} node(s)` +
    (realContradictions.length > 0 ? `, discounted by ${realContradictions.length} contradicting node(s)` : ', no contradictions') +
    (h.prior !== undefined ? `, prior ${h.prior}` : '');
  return { ...h, contradicts: h.contradicts ?? [], confidence, rationale };
}

export function rankHypotheses(graph: EvidenceGraph, hypotheses: HypothesisInput[]): RankedHypothesis[] {
  return hypotheses.map((h) => scoreHypothesis(graph, h)).sort((a, b) => b.confidence - a.confidence);
}

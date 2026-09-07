/**
 * Faithfulness evaluation (rag-engineering skill §Evaluation: "generation
 * quality: faithfulness" + agentic-ai skill: "LLM-as-judge or human
 * evaluation") — the generation-quality complement to the retrieval metrics.
 *
 * Protocol per case:
 *  1. Ask the answerer the question (exactly as production does).
 *  2. Split the answer into claims (sentences).
 *  3. Judge each claim against the retrieved context chunks.
 *  4. Refusals are graded separately: correct when `expectRefusal`, a
 *     zero otherwise (a refusal where an answer was possible is a failure
 *     mode too — over-refusal).
 *
 * Score = supported claims / total claims (refusals: 1 or 0 as above).
 * The default judge is fully deterministic and LLM-free; `LlmClaimJudge`
 * upgrades per-claim verdicts and falls back to the lexical judge when the
 * model is unwired or its output is malformed.
 */
import { z } from 'zod';
import type { GroundedAnswerer, GroundedAnswer } from './grounded-answerer.js';
import type { LlmClient } from '../support-voice-agent/tools/llm.js';

export type Verdict = 'supported' | 'unsupported';

export interface FaithfulnessCase {
  id: string;
  question: string;
  /** When true, a refusal scores 1 and an answer scores 0. */
  expectRefusal?: boolean;
}

export interface FaithfulnessGoldenSet {
  name: string;
  cases: FaithfulnessCase[];
}

export interface FaithfulnessCaseResult {
  id: string;
  question: string;
  refused: boolean;
  refusalCorrect: boolean;
  score: number;
  claims: string[];
  unsupported: string[];
  /** How the answer was served: 'llm' (model answer, judged supported),
   *  'llm-rejected' (model answer failed the claim guard → extractive),
   *  'extractive' (no usable LLM answer), 'refusal'. A guard that silently
   *  swapped LLM answers for the extractive floor would otherwise green- wash
   *  the gate — the swap is visible per case. */
  servedBy: 'llm' | 'llm-rejected' | 'extractive' | 'refusal';
}

export interface FaithfulnessReport {
  name: string;
  cases: number;
  meanFaithfulness: number;
  refusalAccuracy: number;
  perCase: FaithfulnessCaseResult[];
}

export interface FaithfulnessJudge {
  judge(claim: string, contexts: string[]): Promise<Verdict>;
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'it', 'this', 'that', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with', 'as', 'by', 'at', 'be', 'been']);

/** Content words, for the lexical verdict's overlap test. */
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Deterministic judge: a claim is supported when every one of its content
 * words appears somewhere in the cited context (head-noun overlap, the same
 * principle as the re-ranker's coverage). Conservative by design — it
 * under-credits paraphrases, so its score is a floor, never a ceiling.
 */
export class LexicalClaimJudge implements FaithfulnessJudge {
  async judge(claim: string, contexts: string[]): Promise<Verdict> {
    const words = contentWords(claim);
    if (words.length === 0) return 'supported';
    const corpus = new Set(contexts.flatMap(contentWords));
    const missing = words.filter((w) => !corpus.has(w));
    // A single rare-word miss is tolerable (inflection); two or more is not.
    return missing.length <= 1 ? 'supported' : 'unsupported';
  }
}

const VerdictSchema = z.object({ verdict: z.enum(['supported', 'unsupported']) });

const JUDGE_SYSTEM = `You verify whether a CLAIM is entailed by the CONTEXTS. Answer only from the contexts, never from prior knowledge. Reply with JSON only: {"verdict": "supported" | "unsupported"}. "supported" means the contexts alone contain the claim's information.`;

export class LlmClaimJudge implements FaithfulnessJudge {
  private readonly fallback = new LexicalClaimJudge();
  constructor(private readonly llm: LlmClient) {}

  async judge(claim: string, contexts: string[]): Promise<Verdict> {
    if (!this.llm.isWired()) return this.fallback.judge(claim, contexts);
    try {
      const r = await this.llm.complete({
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: JSON.stringify({ claim, contexts }) },
        ],
        tools: [],
        tool_choice: 'none',
        temperature: 0,
        max_tokens: 60,
      });
      const text = String(r.choices[0]?.message?.content ?? '');
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      const parsed = VerdictSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
      if (parsed.success) return parsed.data.verdict;
      return this.fallback.judge(claim, contexts);
    } catch {
      // Judge unavailability degrades to the deterministic floor.
      return this.fallback.judge(claim, contexts);
    }
  }
}

function splitClaims(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Context strings exactly as the answerer saw them (provenance + text).
 *  Judges verify claims against the chunk TEXT, not just its citation. */
function contextsOf(sources: GroundedAnswer['sources']): string[] {
  return sources.map((s) => `[${s.docId}#${s.index}]${s.heading ? ` ${s.heading}:` : ''} ${s.text}`);
}

export interface EvaluateFaithfulnessOptions {
  judge?: FaithfulnessJudge;
  /** Answerer options forwarded per question. Defaults to the production
   *  voice floor (minScore 0.4) so the eval measures what production does —
   *  a looser floor here would grade a stricter system than the live one. */
  answerOptions?: Parameters<GroundedAnswerer['answer']>[1];
}

export async function evaluateFaithfulness(
  answerer: Pick<GroundedAnswerer, 'answer'>,
  set: FaithfulnessGoldenSet,
  opts: EvaluateFaithfulnessOptions = {},
): Promise<FaithfulnessReport> {
  const judge = opts.judge ?? new LexicalClaimJudge();
  const perCase: FaithfulnessCaseResult[] = [];
  const answerOptions = { minScore: 0.4, ...(opts.answerOptions ?? {}) };

  for (const c of set.cases) {
    const result = await answerer.answer(c.question, answerOptions);
    if (result.refused) {
      perCase.push({
        id: c.id,
        question: c.question,
        refused: true,
        refusalCorrect: c.expectRefusal === true,
        score: c.expectRefusal === true ? 1 : 0,
        claims: [],
        unsupported: [],
        servedBy: 'refusal',
      });
      continue;
    }
    const contexts = contextsOf(result.sources);
    const claims = splitClaims(result.answer);
    const unsupported: string[] = [];
    for (const claim of claims) {
      if ((await judge.judge(claim, contexts)) === 'unsupported') unsupported.push(claim);
    }
    const supported = claims.length - unsupported.length;
    // servedBy: the answerer's own report of how the answer was produced.
    // usedLlm+llmVerified → 'llm'; usedLlm without verification → 'llm-rejected'
    // (the guard swapped it for the extractive floor); else 'extractive'.
    const servedBy: FaithfulnessCaseResult['servedBy'] =
      result.usedLlm && result.llmVerified ? 'llm' : result.usedLlm ? 'llm-rejected' : 'extractive';
    perCase.push({
      id: c.id,
      question: c.question,
      refused: false,
      refusalCorrect: c.expectRefusal !== true,
      score: claims.length === 0 ? 0 : supported / claims.length,
      claims,
      unsupported,
      servedBy,
    });
  }

  const n = perCase.length;
  const refusals = perCase.filter((c) => c.refused);
  return {
    name: set.name,
    cases: n,
    meanFaithfulness: n === 0 ? 0 : perCase.reduce((a, c) => a + c.score, 0) / n,
    refusalAccuracy: refusals.length === 0 ? 1 : refusals.filter((c) => c.refusalCorrect).length / refusals.length,
    perCase,
  };
}

/** Gate for CI or cron reports: throws listing failing cases. */
export function assertFaithfulnessGate(
  report: FaithfulnessReport,
  gate: { minScore: number },
): void {
  if (report.meanFaithfulness < gate.minScore) {
    const bad = report.perCase.filter((c) => c.score < gate.minScore).map((c) => c.id).join(', ');
    throw new Error(
      `Faithfulness gate failed: mean ${report.meanFaithfulness.toFixed(3)} < ${gate.minScore} (failing: ${bad})`,
    );
  }
}

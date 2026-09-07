/**
 * GroundedAnswerer (increment 2 of the RAG arc) — the hallucination-reduction
 * layer (rag-engineering skill: "answer only from the provided context",
 * "citation extraction", "detect refusal to answer").
 *
 * Contract, in order:
 *  1. Retrieve. Empty/near-zero retrieval → refuse. The LLM is NEVER called
 *     without context, so "confident guess from nothing" is structurally
 *     impossible.
 *  2. Number the retrieved chunks into an explicit context block and instruct
 *     the model to answer ONLY from it, citing the numbers it used.
 *  3. Validate the reply with Zod; filter citations to numbers that actually
 *     exist in the supplied context (a hallucinated citation is dropped, and
 *     an answer left with zero real citations is invalid → fallback).
 *  4. Degrade honestly: LLM unwired/invalid/unavailable → an extractive
 *     answer assembled from the top chunk itself (still cited, still
 *     grounded — the floor is the corpus, not the model).
 */
import { z } from 'zod';
import type { FileBackedKnowledgeBase, KnowledgeHit, SearchOptions } from './knowledge/knowledge-base.js';
import type { LlmClient } from '../support-voice-agent/tools/llm.js';
import type { FaithfulnessJudge, Verdict } from './faithfulness-eval.js';

const AnswerSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(z.number().int().positive()).max(20).default([]),
});

const GroundedAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(z.number()),
  refused: z.boolean(),
  usedLlm: z.boolean(),
  /** True when every claim of an LLM answer passed the configured claim
   *  judge. False for extractive answers (they ARE the corpus) and when no
   *  judge is configured (honest: unverified, not silently trusted). */
  llmVerified: z.boolean().default(false),
  sources: z.array(
    z.object({
      docId: z.string(),
      index: z.number(),
      heading: z.string(),
      source: z.string().optional(),
      score: z.number(),
      /** The chunk text, so citation consumers (and the faithfulness
       *  judge) can verify claims without re-reading the KB. */
      text: z.string(),
    }),
  ),
  contextSize: z.number(),
});

export type GroundedAnswer = z.output<typeof GroundedAnswerSchema>;

export interface GroundedAnswererOptions {
  knowledge: FileBackedKnowledgeBase;
  /** LLM optional: unwired → always extractive answers (still grounded). */
  llm?: LlmClient;
  /** Optional claim-verification guard (the faithfulness harness's judge
   *  contract, reused in the request path): every claim of an LLM answer is
   *  judged against its cited context; any 'unsupported' claim fails the
   *  whole answer to the deterministic extractive floor. Hallucination
   *  prevention, not detection-after-the-fact. */
  claimJudge?: FaithfulnessJudge;
}

export interface AnswerOptions {
  topK?: number;
  /** Retrieval floor; below it there is nothing to ground in (default 0.05). */
  minScore?: number;
  /** Query-time metadata filter (e.g. { source: 'runbooks' }). */
  where?: SearchOptions['where'];
}

const REFUSAL =
  "I don't have verified knowledge about that in my sources, so I won't guess. Add a runbook or postmortem covering it and ask again.";

export class GroundedAnswerer {
  constructor(private readonly opts: GroundedAnswererOptions) {}

  async answer(question: string, opts: AnswerOptions = {}): Promise<GroundedAnswer> {
    const topK = opts.topK ?? 4;
    const minScore = opts.minScore ?? 0.05;
    const hits = await this.opts.knowledge.search(question, {
      topK,
      minScore,
      ...(opts.where ? { where: opts.where } : {}),
    });

    const sources = hits.map((h) => ({
      docId: h.docId,
      index: h.index,
      heading: h.heading,
      ...(typeof h.metadata?.['source'] === 'string' ? { source: h.metadata['source'] as string } : {}),
      score: h.score,
      text: h.text,
    }));

    if (hits.length === 0) {
      return {
        answer: REFUSAL,
        citations: [],
        refused: true,
        usedLlm: false,
        llmVerified: false,
        sources: [],
        contextSize: 0,
      };
    }

    const ctx = buildNumberedContext(hits);
    const llm = this.opts.llm;
    if (llm?.isWired()) {
      try {
        const raw = await llm.complete({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `CONTEXT:\n${ctx}\n\nQUESTION: ${question}` },
          ],
          tools: [],
          tool_choice: 'none',
          temperature: 0,
          max_tokens: 4000,
        });
        const text = String(raw.choices[0]?.message?.content ?? '');
        const parsed = AnswerSchema.safeParse(safeJson(text));
        if (parsed.success) {
          const valid = [...new Set(parsed.data.citations)].filter((n) => n >= 1 && n <= hits.length);
          // A citation-less answer is unsupported by construction → fallback.
          if (valid.length > 0) {
            const answer = parsed.data.answer.trim();
            // Claim-verification guard (when a judge is configured): every
            // sentence must be entailed by the context it cites. Any
            // unsupported claim — or a judge failure — fails CLOSED to the
            // extractive floor: a hallucination is never emitted.
            const judge = this.opts.claimJudge;
            if (judge) {
              const contexts = sources.map((s) => `[${s.docId}#${s.index}]${s.heading ? ` ${s.heading}:` : ''} ${s.text}`);
              const ok = await allClaimsSupported(answer, judge, contexts);
              if (!ok) {
                return this.extractive(question, hits, sources);
              }
              return {
                answer,
                citations: valid,
                refused: false,
                usedLlm: true,
                llmVerified: true,
                sources,
                contextSize: hits.length,
              };
            }
            return {
              answer,
              citations: valid,
              refused: false,
              usedLlm: true,
              llmVerified: false,
              sources,
              contextSize: hits.length,
            };
          }
        }
      } catch {
        // Transport/schema failure → extractive floor below (honest, cited).
      }
    }

    return this.extractive(question, hits, sources);
  }

  /** The deterministic floor: an extractive answer from the top chunk —
   *  grounded by construction (it IS the source), never verified-LLM. */
  private extractive(
    question: string,
    hits: KnowledgeHit[],
    sources: GroundedAnswer['sources'],
  ): GroundedAnswer {
    const top = hits[0] as KnowledgeHit;
    return {
      answer: extractiveAnswer(question, top),
      citations: [1],
      refused: false,
      usedLlm: false,
      llmVerified: false,
      sources,
      contextSize: hits.length,
    };
  }
}

/** Split an answer into sentence-level claims and require EVERY one to be
 *  entailed. A judge throw fails closed (unsupported). */
async function allClaimsSupported(
  answer: string,
  judge: FaithfulnessJudge,
  contexts: string[],
): Promise<boolean> {
  const claims = answer
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (claims.length === 0) return false;
  for (const claim of claims) {
    try {
      const verdict: Verdict = await judge.judge(claim, contexts);
      if (verdict !== 'supported') return false;
    } catch {
      return false;
    }
  }
  return true;
}

function safeJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Explicit numbered context block: the model can only cite what it sees. */
function buildNumberedContext(hits: KnowledgeHit[]): string {
  return hits
    .map((h, i) => {
      const src = typeof h.metadata?.['source'] === 'string' ? ` (source: ${h.metadata['source']})` : '';
      return `[${i + 1}] ${h.docId}#${h.index}${src}${h.heading ? ` — ${h.heading}` : ''}\n${h.text}`;
    })
    .join('\n\n');
}

const SYSTEM_PROMPT = `You answer support-engineer questions from a numbered CONTEXT block and nothing else.

Rules:
- Use ONLY facts present in the context. Never use prior knowledge.
- Quote the context closely; do not add specifics it does not state (e.g. do not turn "escalate to X" into "X gets paged").
- State facts directly. Never write meta-references like "the context says" or "according to the sources" — restate the fact itself, not a description of the context.
- Cite the context numbers supporting your answer in "citations".
- If the context does not contain the answer, do not invent it: set "citations" to [] and put a one-sentence "the sources do not cover this" reply in "answer".
- Reply with JSON only: {"answer": string, "citations": number[]}`;

/**
 * Extractive floor: the most query-relevant sentences of the top chunk, with
 * the chunk's own heading. Deterministic, dependency-free, and grounded by
 * construction — it IS the source.
 */
export function extractiveAnswer(question: string, hit: KnowledgeHit): string {
  const qTerms = new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const sentences = hit.text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const scored = sentences.map((s, i) => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    const overlap = words.filter((w) => qTerms.has(w)).length;
    return { s, i, overlap };
  });
  const best = scored
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.i - b.i)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i);
  const body = (best.length > 0 ? best.map((x) => x.s) : sentences.slice(0, 1)).join(' ');
  const head = hit.heading ? `${hit.heading}: ` : '';
  return `${head}${body}`.trim();
}

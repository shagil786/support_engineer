import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroundedAnswerer } from '../../src/understanding/grounded-answerer';
import type { GroundedAnswererOptions } from '../../src/understanding/grounded-answerer';
import { FileBackedKnowledgeBase } from '../../src/understanding/knowledge/knowledge-base';
import type { LlmClient, LlmChatRequest, LlmChatResponse } from '../../src/support-voice-agent/tools/llm';

/* Fake KB seeded with one runbook and one incident doc. */
async function seededKb(root: string): Promise<FileBackedKnowledgeBase> {
  const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
  await kb.ingest({
    id: 'run-restart',
    text: '# Restart the checkout pod\nUse this runbook when the checkout service stops responding.',
    metadata: { source: 'runbooks', tags: ['checkout'] },
  });
  await kb.ingest({
    id: 'inc-42',
    text: 'Postmortem: the checkout timeout incident was caused by connection pool exhaustion.',
    metadata: { source: 'incidents', tags: ['payments'] },
  });
  return kb;
}

/* Fake LLM that echoes the citations it was given (drops ones not in context). */
class EchoLlm implements LlmClient {
  isWired(): boolean {
    return true;
  }
  constructor(private readonly answer: (prompt: string) => unknown) {}
  async complete(request: LlmChatRequest): Promise<LlmChatResponse> {
    const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
    const out = this.answer(user);
    return {
      id: 'fake',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(out) }, finish_reason: 'stop' }],
    } as unknown as LlmChatResponse;
  }
}

const wired = (kb: FileBackedKnowledgeBase, llm: LlmClient): GroundedAnswererOptions => ({ knowledge: kb, llm });

describe('GroundedAnswerer', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grounded-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses honestly when retrieval is empty — no LLM call is made', async () => {
    let called = 0;
    const llm: LlmClient = {
      isWired: () => true,
      complete: async () => {
        called += 1;
        throw new Error('LLM must not be called when there is nothing to ground in');
      },
    };
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer(wired(kb, llm));
    const r = await ga.answer('zzzqqq xyzzyx wumpus', { minScore: 0.5 });
    expect(called).toBe(0);
    expect(r.refused).toBe(true);
    expect(r.citations).toEqual([]);
    expect(r.answer).toMatch(/don't have|no (verified|knowledge)/i);
  });

  it('constructs numbered context and filters hallucinated citations', async () => {
    const llm = new EchoLlm(() => ({
      answer: 'Restart the pod.',
      citations: [1, 7], // 7 does not exist in a 2-chunk context
    }));
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer(wired(kb, llm));
    const r = await ga.answer('checkout not responding');
    expect(r.answer).toBe('Restart the pod.');
    expect(r.citations).toEqual([1]);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.usedLlm).toBe(true);
  });

  it('rejects schema-invalid LLM output and falls back to extraction', async () => {
    const llm = new EchoLlm(() => ({ speech: 'wrong shape entirely' }));
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer(wired(kb, llm));
    const r = await ga.answer('connection pool exhaustion');
    expect(r.usedLlm).toBe(false);
    expect(r.answer.length).toBeGreaterThan(0);
    expect(r.citations.length).toBeGreaterThan(0);
  });

  it('extractive fallback answers from the top chunk with its citation', async () => {
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer(wired(kb, { isWired: () => false, complete: async () => { throw new Error('unwired'); } }));
    const r = await ga.answer('connection pool exhaustion');
    expect(r.usedLlm).toBe(false);
    expect(r.citations).toContain(1);
    expect(r.answer.toLowerCase()).toContain('pool exhaustion');
  });

  it('respects topK and query-time metadata filters', async () => {
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer(wired(kb, new EchoLlm(() => ({ answer: 'x', citations: [1] }))));
    const r = await ga.answer('checkout', { where: { source: 'runbooks' }, topK: 1 });
    expect(r.sources.map((s) => s.source)).toEqual(['runbooks']);
    expect(r.contextSize).toBe(1);
  });

  it('a citation-only LLM answer (empty text) is treated as invalid → extractive fallback', async () => {
    const llm = new EchoLlm(() => ({ answer: '', citations: [1] }));
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer(wired(kb, llm));
    const r = await ga.answer('pool exhaustion');
    expect(r.usedLlm).toBe(false);
    expect(r.answer.length).toBeGreaterThan(0);
  });

  it('claim-verification guard: an unsupported LLM claim drops to the extractive floor', async () => {
    // The LLM invents "the secondary gets paged" — the corpus never says it.
    const llm = new EchoLlm(() => ({
      answer: 'Escalate to the secondary. The secondary gets paged when on-call escalation fires.',
      citations: [1],
    }));
    const kb = await seededKb(root);
    const strictJudge = {
      judge: async (claim: string) => (claim.includes('paged') ? 'unsupported' : 'supported'),
    };
    const ga = new GroundedAnswerer({ knowledge: kb, llm, claimJudge: strictJudge });
    const r = await ga.answer('who gets paged when oncall escalation fires');
    expect(r.usedLlm).toBe(false); // the LLM answer was rejected
    expect(r.answer).not.toContain('paged');
    expect(r.citations).toEqual([1]);
    expect(r.llmVerified).toBe(false);
  });

  it('claim-verification guard: supported claims keep the LLM answer, marked verified', async () => {
    const llm = new EchoLlm(() => ({ answer: 'Restart the checkout pod single-pod.', citations: [1] }));
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer({
      knowledge: kb,
      llm,
      claimJudge: { judge: async () => 'supported' },
    });
    const r = await ga.answer('checkout not responding');
    expect(r.usedLlm).toBe(true);
    expect(r.llmVerified).toBe(true);
    expect(r.answer).toContain('single-pod');
  });

  it('no claim judge configured → LLM answers still flow, honestly unverified', async () => {
    const llm = new EchoLlm(() => ({ answer: 'Restart the pod.', citations: [1] }));
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer(wired(kb, llm));
    const r = await ga.answer('checkout not responding');
    expect(r.usedLlm).toBe(true);
    expect(r.llmVerified).toBe(false);
  });

  it('a throwing claim judge fails closed to the extractive floor', async () => {
    const llm = new EchoLlm(() => ({ answer: 'Restart the pod.', citations: [1] }));
    const kb = await seededKb(root);
    const ga = new GroundedAnswerer({
      knowledge: kb,
      llm,
      claimJudge: { judge: async () => { throw new Error('judge down'); } },
    });
    const r = await ga.answer('checkout not responding');
    expect(r.usedLlm).toBe(false);
    expect(r.citations).toEqual([1]);
  });
});

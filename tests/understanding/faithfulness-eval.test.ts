import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackedKnowledgeBase } from '../../src/understanding/knowledge/knowledge-base';
import { GroundedAnswerer } from '../../src/understanding/grounded-answerer';
import {
  LexicalClaimJudge,
  LlmClaimJudge,
  evaluateFaithfulness,
  assertFaithfulnessGate,
} from '../../src/understanding/faithfulness-eval';
import type { FaithfulnessGoldenSet as FaithfulnessSet } from '../../src/understanding/faithfulness-eval';
import { RETRIEVAL_SEED_DOCS } from '../../src/fixtures/retrieval-golden-set';
import type { LlmClient, LlmChatRequest, LlmChatResponse } from '../../src/support-voice-agent/tools/llm';

const ANSWERABLE_SET: FaithfulnessSet = {
  name: 'faithfulness-shipped',
  cases: [
    { id: 'f1', question: 'how do I restart the checkout pod' },
    { id: 'f2', question: 'what caused the checkout timeout incident' },
    { id: 'f3', question: 'who gets paged when oncall escalation fires' },
    { id: 'f4', question: 'who won the 2026 championship', expectRefusal: true },
  ],
};

describe('evaluateFaithfulness', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'faith-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function seededAnswerer(): Promise<GroundedAnswerer> {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    for (const doc of RETRIEVAL_SEED_DOCS) await kb.ingest(doc);
    const llm: LlmClient = { isWired: () => false, complete: async () => { throw new Error('unwired'); } };
    return new GroundedAnswerer({ knowledge: kb, llm }); // extractive floor
  }

  it('extractive answers over the corpus score perfect faithfulness', async () => {
    const report = await evaluateFaithfulness(await seededAnswerer(), ANSWERABLE_SET, {
      judge: new LexicalClaimJudge(),
    });
    expect(report.cases).toBe(4);
    expect(report.meanFaithfulness).toBe(1);
    const f4 = report.perCase.find((c) => c.id === 'f4');
    expect(f4?.refused).toBe(true);
    expect(f4?.refusalCorrect).toBe(true);
    expect(f4?.score).toBe(1);
    for (const c of report.perCase) {
      expect(c.unsupported).toEqual([]);
    }
  });

  it('flags unsupported claims for a hallucinating answerer', async () => {
    const liar = {
      answer: async (q: string) => ({
        answer: q.includes('timeout')
          ? 'The checkout timeout was caused by a hamster chewing the fiber cable. Mitigation was a full datacenter rebuild.'
          : 'Flux capacitor recalibration.',
        citations: [1],
        refused: false,
        usedLlm: true,
        llmVerified: false,
        sources: [{ docId: 'inc-42', index: 0, heading: '', score: 1, text: 'Postmortem: the checkout timeout incident was caused by connection pool exhaustion.' }],
        contextSize: 1,
      }),
    };
    const report = await evaluateFaithfulness(liar, {
      name: 'liar',
      cases: [
        { id: 'l1', question: 'what caused the checkout timeout incident' },
        { id: 'l2', question: 'how do I restart the checkout pod' },
      ],
    }, { judge: new LexicalClaimJudge() });
    expect(report.meanFaithfulness).toBeLessThan(0.5);
    const l1 = report.perCase.find((c) => c.id === 'l1');
    expect(l1?.unsupported.length).toBeGreaterThan(0);
    expect(l1?.unsupported.join(' ')).toMatch(/hamster|datacenter/i);
  });

  it('a refusal where an answer was expected scores zero', async () => {
    const refuser = {
      answer: async () => ({
        answer: "I don't have verified knowledge about that.",
        citations: [],
        refused: true,
        usedLlm: false,
        llmVerified: false,
        sources: [],
        contextSize: 0,
      }),
    };
    const report = await evaluateFaithfulness(refuser, {
      name: 'refuser',
      cases: [{ id: 'r1', question: 'how do I restart the checkout pod' }],
    }, { judge: new LexicalClaimJudge() });
    expect(report.perCase[0]?.score).toBe(0);
    expect(report.perCase[0]?.refusalCorrect).toBe(false);
    expect(report.meanFaithfulness).toBe(0);
  });

  it('LlmClaimJudge sends claims+contexts and Zod-validates verdicts', async () => {
    const captured: Array<{ body: Record<string, unknown> }> = [];
    const llm: LlmClient = {
      isWired: () => true,
      complete: async (request: LlmChatRequest) => {
        captured.push({ body: JSON.parse(String(request.messages.at(-1)?.content ?? '{}')) as Record<string, unknown> });
        return {
          id: 'j',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ verdict: 'supported' }) } }],
        } as unknown as LlmChatResponse;
      },
    };
    const judge = new LlmClaimJudge(llm);
    const v = await judge.judge('Restart the checkout pod.', ['[1] run-restart#0 — Restart the checkout pod.']);
    expect(v).toBe('supported');
    expect(captured[0]?.body).toMatchObject({ claim: 'Restart the checkout pod.' });
    expect(JSON.stringify(captured[0]?.body['contexts'])).toContain('run-restart');
  });

  it('LlmClaimJudge falls back to the lexical judge on malformed output', async () => {
    const llm: LlmClient = {
      isWired: () => true,
      complete: async () => ({ id: 'j', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'not json at all' } }] }) as unknown as LlmChatResponse,
    };
    const judge = new LlmClaimJudge(llm);
    // "hamster" appears nowhere in the context → lexical says unsupported.
    const v = await judge.judge('A hamster chewed the cable.', ['[1] Restart the checkout pod when it stops responding.']);
    expect(v).toBe('unsupported');
  });

  it('the quality gate passes above threshold and throws with failing cases below', async () => {
    const report = await evaluateFaithfulness(await seededAnswerer(), ANSWERABLE_SET, {
      judge: new LexicalClaimJudge(),
    });
    expect(() => assertFaithfulnessGate(report, { minScore: 1 })).not.toThrow();
    const bad = { ...report, meanFaithfulness: 0.5, perCase: report.perCase.map((c) => ({ ...c, score: 0.5 })) };
    expect(() => assertFaithfulnessGate(bad, { minScore: 0.9 })).toThrow(/faithfulness/i);
  });
});

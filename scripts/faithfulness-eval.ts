#!/usr/bin/env node
/**
 * Faithfulness eval CLI — generation-quality gate for the GroundedAnswerer.
 *
 *   npx tsx scripts/faithfulness-eval.ts [--min-score <f>] [--judge lexical|llm]
 *
 * Asks the shipped questions exactly as production does (0.4 floor) and
 * grades every claim of every answer against its cited context. The default
 * lexical judge is deterministic and LLM-free; --judge llm upgrades verdicts
 * to LLM-as-judge (EMBEDDINGS-style LLM_* env), degrading per-claim to the
 * lexical floor when the model is unusable.
 *
 * Exit codes: 0 = gate passed, 1 = gate failed, 2 = usage/IO error.
 */
import { join } from 'node:path';
import { FileBackedKnowledgeBase } from '../src/understanding/knowledge/knowledge-base.js';
import { GroundedAnswerer } from '../src/understanding/grounded-answerer.js';
import {
  evaluateFaithfulness,
  assertFaithfulnessGate,
  LexicalClaimJudge,
  LlmClaimJudge,
} from '../src/understanding/faithfulness-eval.js';
import { RETRIEVAL_SEED_DOCS } from '../src/fixtures/retrieval-golden-set.js';
import { OpenAiCompatibleClient } from '../src/support-voice-agent/tools/llm.js';
import { existsSync } from 'node:fs';

let minScore = 0.9;
let judgeKind: 'lexical' | 'llm' = 'lexical';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const take = (name: string): string => {
    const v = args[i + 1];
    if (!v || v.startsWith('--')) {
      console.error(`error: ${name} requires a value`);
      process.exit(2);
    }
    i += 1;
    return v;
  };
  if (args[i] === '--min-score') minScore = Number(take('--min-score'));
  else if (args[i] === '--judge') judgeKind = take('--judge') as 'lexical' | 'llm';
  else {
    console.error(`error: unknown argument ${args[i]}`);
    process.exit(2);
  }
}
if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
  console.error('error: --min-score must be a number in [0, 1]');
  process.exit(2);
}

const SET = {
  name: 'faithfulness-shipped',
  cases: [
    { id: 'f1', question: 'how do I restart the checkout pod' },
    { id: 'f2', question: 'what caused the checkout timeout incident' },
    { id: 'f3', question: 'who gets paged when oncall escalation fires' },
    { id: 'f4', question: '503 gateway config push fix' },
    { id: 'f5', question: 'who won the 2026 championship', expectRefusal: true },
    { id: 'f6', question: 'what is the meaning of life', expectRefusal: true },
  ],
};

const kbPath = join(process.cwd(), 'var/knowledge/kb.json');
const seededHere = !existsSync(kbPath);
const kb = new FileBackedKnowledgeBase({ path: kbPath });
if (seededHere) {
  for (const doc of RETRIEVAL_SEED_DOCS) await kb.ingest(doc);
  console.log('Seeded empty KB with the shipped corpus for grading.');
}

const llm = new OpenAiCompatibleClient({
  baseUrl: process.env['LLM_BASE_URL'] ?? '',
  apiKey: process.env['LLM_API_KEY'] ?? '',
  model: process.env['LLM_MODEL'] ?? '',
});
const answerer = new GroundedAnswerer({ knowledge: kb, llm });
const judge = judgeKind === 'llm' ? new LlmClaimJudge(llm) : new LexicalClaimJudge();

const report = await evaluateFaithfulness(answerer, SET, { judge });
console.log(
  `Faithfulness eval '${report.name}': ${report.cases} cases, mean=${report.meanFaithfulness.toFixed(3)}, refusalAccuracy=${report.refusalAccuracy.toFixed(3)} (judge: ${judgeKind})`,
);
for (const c of report.perCase) {
  if (c.refused) {
    console.log(`  ${c.refusalCorrect ? 'OK  ' : 'FAIL'} ${c.id}: refused (${c.refusalCorrect ? 'expected' : 'over-refusal'})`);
  } else {
    for (const u of c.unsupported) console.log(`  FAIL ${c.id}: unsupported claim — "${u}"`);
    if (c.unsupported.length === 0) console.log(`  OK   ${c.id}: ${c.claims.length} claim(s) supported`);
  }
}

try {
  assertFaithfulnessGate(report, { minScore });
  console.log('Faithfulness gate: PASS');
} catch (e) {
  console.error(`Faithfulness gate: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

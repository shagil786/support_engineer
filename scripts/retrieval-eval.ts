#!/usr/bin/env node
/**
 * Retrieval eval CLI — CI gate for the knowledge base's retrieval quality.
 *
 *   npx tsx scripts/retrieval-eval.ts [--kb <path>] [--min-hit-rate <f>] [--min-mrr <f>]
 *
 * Runs the shipped golden set (fixtures/retrieval-golden-set.ts) against the
 * knowledge base at var/knowledge/kb.json (or --kb). The KB is seeded from
 * the shipped corpus when empty, so the gate works on a fresh checkout;
 * point --kb at a production snapshot to grade real data.
 *
 * Exit codes: 0 = gate passed, 1 = gate failed, 2 = usage/IO error.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FileBackedKnowledgeBase } from '../src/understanding/knowledge/knowledge-base.js';
import { evaluateRetrieval, assertQualityGate } from '../src/understanding/knowledge/retrieval-eval.js';
import { RETRIEVAL_SEED_DOCS, RETRIEVAL_GOLDEN_SET } from '../src/fixtures/retrieval-golden-set.js';

// --- args ----------------------------------------------------------------
let kbPath = join(process.cwd(), 'var/knowledge/kb.json');
let minHitRate = 1;
let minMrr = 0.9;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const take = (name: string): string => {
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      console.error(`error: ${name} requires a value`);
      process.exit(2);
    }
    i += 1;
    return value;
  };
  if (args[i] === '--kb') kbPath = resolve(take('--kb'));
  else if (args[i] === '--min-hit-rate') minHitRate = Number(take('--min-hit-rate'));
  else if (args[i] === '--min-mrr') minMrr = Number(take('--min-mrr'));
  else {
    console.error(`error: unknown argument ${args[i]}`);
    process.exit(2);
  }
}
if (!Number.isFinite(minHitRate) || minHitRate < 0 || minHitRate > 1) {
  console.error('error: --min-hit-rate must be a number in [0, 1]');
  process.exit(2);
}
if (!Number.isFinite(minMrr) || minMrr < 0 || minMrr > 1) {
  console.error('error: --min-mrr must be a number in [0, 1]');
  process.exit(2);
}

// --- run ------------------------------------------------------------------
const seededHere = !existsSync(kbPath);
const kb = new FileBackedKnowledgeBase({ path: kbPath });
if (seededHere) {
  for (const doc of RETRIEVAL_SEED_DOCS) await kb.ingest(doc);
  console.log(`Seeded empty KB (${kbPath}) with the shipped corpus for grading.`);
}

const result = await evaluateRetrieval(kb, RETRIEVAL_GOLDEN_SET);
console.log(
  `Retrieval eval '${result.name}': ${result.cases} cases, hitRate=${result.hitRate.toFixed(3)}, mrr=${result.mrr.toFixed(3)}`,
);
for (const f of result.failures) {
  console.log(`  MISS ${f.id}: "${f.query}" → expected one of ${f.expected.join(', ')} (not in top results)`);
}

try {
  assertQualityGate(result, { minHitRate, minMrr });
  console.log('Retrieval quality gate: PASS');
} catch (e) {
  console.error(`Retrieval quality gate: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

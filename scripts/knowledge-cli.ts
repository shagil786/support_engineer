#!/usr/bin/env node
/**
 * knowledge-cli — ingest and query the durable hybrid knowledge base.
 *
 *   npx tsx scripts/knowledge-cli.ts seed                       # load the shipped seed corpus
 *   npx tsx scripts/knowledge-cli.ts ingest <file.md> [source]  # ingest a markdown/text file
 *   npx tsx scripts/knowledge-cli.ts search "<query>"           # hybrid search (BM25 + vector)
 *   npx tsx scripts/knowledge-cli.ts list                       # list ingested documents
 *   npx tsx scripts/knowledge-cli.ts reindex                    # re-embed after an embedder swap
 *
 * Storage: var/knowledge/kb.json (atomic snapshot; survives restarts).
 */
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { FileBackedKnowledgeBase } from '../src/understanding/knowledge/knowledge-base.js';
import { OpenAiCompatibleEmbedder } from '../src/understanding/memory/embedders/openai.js';
import { embeddingsFromEnv } from '../src/config.js';
import { RETRIEVAL_SEED_DOCS } from '../src/fixtures/retrieval-golden-set.js';

const [cmd, arg, source] = process.argv.slice(2);

if (cmd === 'seed') {
  const kbase = openKb();
  let total = 0;
  for (const doc of RETRIEVAL_SEED_DOCS) total += await kbase.ingest(doc);
  console.log(`Seeded ${RETRIEVAL_SEED_DOCS.length} documents (${total} chunks) into var/knowledge/kb.json`);
} else if (cmd === 'ingest' && arg) {
  const kbase = openKb();
  const text = readFileSync(resolve(process.cwd(), arg), 'utf8');
  const chunks = await kbase.ingest({ id: fileDocId(arg), text, metadata: source ? { source } : undefined });
  console.log(`Ingested ${arg} as ${chunks} chunks`);
} else if (cmd === 'search' && arg) {
  const kbase = openKb();
  const hits = await kbase.search(arg, { topK: 5 });
  if (hits.length === 0) {
    console.log('No results.');
  }
  for (const h of hits) {
    console.log(`[${h.score.toFixed(3)}] ${h.docId}#${h.index} — ${h.heading || '(preamble)'} ${JSON.stringify(h.metadata ?? {})}`);
    console.log(`  ${h.text.replace(/\n/g, ' ').slice(0, 160)}${h.text.length > 160 ? '…' : ''}`);
  }
} else if (cmd === 'list') {
  const kbase = openKb();
  const ids = kbase.docIds();
  console.log(ids.length === 0 ? 'No documents ingested.' : `${ids.length} documents: ${ids.join(', ')}`);
} else if (cmd === 'reindex') {
  // One-time migration after switching embedding backends: re-embeds every
  // chunk under the CURRENT embedder (hash by default; cloud when the
  // EMBEDDINGS_* env is set) and persists. Docs and BM25 are untouched.
  const kbase = openKb();
  const n = await kbase.reindex();
  console.log(`Reindexed ${n} chunks under the current embedder.`);
} else {
  console.error('Usage: npx tsx scripts/knowledge-cli.ts <seed|ingest <file> [source]|search "<query>"|list|reindex>');
  process.exit(1);
}

function openKb(): FileBackedKnowledgeBase {
  const embeddings = embeddingsFromEnv(process.env);
  const embedder = embeddings
    ? new OpenAiCompatibleEmbedder({
        baseUrl: embeddings.baseUrl,
        apiKey: embeddings.apiKey,
        model: embeddings.model,
        ...(embeddings.dim !== undefined ? { dim: embeddings.dim } : {}),
      }).embed
    : undefined;
  return new FileBackedKnowledgeBase({
    path: resolve(process.cwd(), 'var', 'knowledge', 'kb.json'),
    ...(embedder ? { embedder } : {}),
  });
}

function fileDocId(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '');
}

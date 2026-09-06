#!/usr/bin/env node
/**
 * knowledge-cli — ingest and query the durable hybrid knowledge base.
 *
 *   npx tsx scripts/knowledge-cli.ts seed                       # load the shipped seed corpus
 *   npx tsx scripts/knowledge-cli.ts ingest <file.md> [source]  # ingest a markdown/text file
 *   npx tsx scripts/knowledge-cli.ts search "<query>"           # hybrid search (BM25 + vector)
 *   npx tsx scripts/knowledge-cli.ts list                       # list ingested documents
 *
 * Storage: var/knowledge/kb.json (atomic snapshot; survives restarts).
 */
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { FileBackedKnowledgeBase } from '../src/understanding/knowledge/knowledge-base.js';
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
} else {
  console.error('Usage: npx tsx scripts/knowledge-cli.ts <seed|ingest <file> [source]|search "<query>"|list>');
  process.exit(1);
}

function openKb(): FileBackedKnowledgeBase {
  return new FileBackedKnowledgeBase({ path: resolve(process.cwd(), 'var', 'knowledge', 'kb.json') });
}

function fileDocId(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '');
}

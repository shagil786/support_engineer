/**
 * FileBackedKnowledgeBase — the hybrid retrieval substrate (rag-engineering
 * skill): ingestion → semantic chunking → hybrid scoring (BM25 lexical +
 * cosine vector) → reciprocal-rank fusion → deterministic re-rank → top-K.
 *
 * Storage mirrors FileBackedVectorMemory's snapshot approach (atomic
 * tmp+rename, fail-open on corrupt files, in-memory set stays correct when a
 * flush fails). Chunks are the unit of retrieval; documents are the unit of
 * replacement (re-ingest or deleteDoc by id).
 *
 * Composite indexing: chunk vectors re-embed through the injected VectorMemory
 * (a real cloud embedder slots in behind the same port); the BM25 index lives
 * alongside. Candidates are the union of both signals' top-K, so neither
 * signal can single-handedly miss a relevant chunk.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Chunk, IngestDoc } from './chunker.js';
import { chunkDocument } from './chunker.js';
import { Bm25Index, tokenizeBm25 } from './bm25.js';
import type { VectorMemory, MemoryRecord, EmbedderLike } from '../memory/vector.js';
import { InMemoryVectorMemory } from '../memory/vector.js';

export interface KnowledgeHit extends Chunk {
  score: number;
}

export interface SearchOptions {
  topK?: number;
  /** Minimum final (re-ranked) score; near-zero matches are noise, not
   *  results — a garbage query returns [] rather than the least-bad chunk. */
  minScore?: number;
  /** Query-time metadata pre-filter (rag-engineering skill: "pre-filter by
   *  metadata before search"). `tags` requires ALL listed tags to match. */
  where?: {
    source?: string;
    tags?: string[];
    /** Exact-match on any other metadata key. */
    [key: string]: unknown;
  };
}

export interface FileBackedKnowledgeBaseOptions {
  /** Snapshot file path; parent directories created on first write. */
  path: string;
  /** Optional backing store for chunk embeddings; defaults to in-memory
   *  (vectors re-embed on boot — the BM25 index is rebuilt the same way). */
  vectorMemory?: VectorMemory;
  /** Embedder for the KB's own default vector store (ignored when an
   *  explicit `vectorMemory` carries its own). Swapping backends requires a
   *  one-time `reindex()`. */
  embedder?: EmbedderLike;
  /** Chunking tunables passed through to chunkDocument. */
  maxChars?: number;
  overlapChars?: number;
}

/** Reciprocal-rank fusion constant (standard 60; parameter-free blend). */
const RRF_K = 60;
/** Candidate pools per signal before fusion. */
const CANDIDATE_K = 20;

interface Snapshot {
  version: 1;
  docs: Record<string, { chunks: Chunk[] }>;
}

function isSnapshot(x: unknown): x is Snapshot {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return o['version'] === 1 && typeof o['docs'] === 'object' && o['docs'] !== null;
}

export class FileBackedKnowledgeBase {
  private readonly path: string;
  private readonly vectors: VectorMemory;
  private readonly bm25 = new Bm25Index();
  private readonly docs = new Map<string, Chunk[]>();
  private readonly maxChars?: number;
  private readonly overlapChars?: number;
  /** In-flight vector-indexing promises. Async embedders (local models,
   *  HTTP backends) make indexing genuinely concurrent with search — every
   *  add is tracked so `search()` can settle the backlog first. Without
   *  this, a query racing construction or ingest sees an empty vector pool
   *  and silently loses the entire semantic signal. */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(opts: FileBackedKnowledgeBaseOptions) {
    this.path = opts.path;
    this.vectors = opts.vectorMemory ?? new InMemoryVectorMemory(opts.embedder ? { embedder: opts.embedder } : {});
    this.maxChars = opts.maxChars;
    this.overlapChars = opts.overlapChars;
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return; // missing file = empty store (first run)
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isSnapshot(parsed)) return;
      for (const [docId, entry] of Object.entries(parsed.docs)) {
        this.docs.set(docId, entry.chunks);
      }
      this.rebuildIndexes();
    } catch {
      // Corrupt snapshot: fail open (empty store); repaired on next mutation.
      return;
    }
  }

  private persist(): void {
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const snapshot: Snapshot = {
        version: 1,
        docs: Object.fromEntries([...this.docs.entries()].map(([id, chunks]) => [id, { chunks }])),
      };
      writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
      renameSync(tmp, this.path); // atomic on POSIX
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      console.error(`FileBackedKnowledgeBase: persist failed for ${this.path}:`, e);
    }
  }

  /** Track a fire-and-forget vector add: settleable by search(), logged on
   *  failure (a failed embed must not reject unhandled — the chunk stays
   *  BM25-searchable; the semantic signal for it is simply absent). */
  private track(p: Promise<unknown>): void {
    const tracked = p.catch((e: unknown) => {
      console.error('KnowledgeBase: vector indexing failed for a chunk:', e);
    });
    this.pending.add(tracked);
    void tracked.finally(() => {
      this.pending.delete(tracked);
    });
  }

  /** Resolve when every tracked indexing promise has settled. */
  private async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /** Corpus snapshot for readiness/ops surfaces. */
  stats(): { docs: number; chunks: number } {
    let chunks = 0;
    for (const c of this.docs.values()) chunks += c.length;
    return { docs: this.docs.size, chunks };
  }

  /** Resolves once boot-time vector indexing has settled (re-embeds from the
   *  snapshot happen on construction; readiness surfaces await this). */
  async whenIndexed(): Promise<void> {
    await this.settle();
  }

  private rebuildIndexes(): void {
    for (const [docId, chunks] of this.docs) {
      for (const c of chunks) {
        this.bm25.add(chunkKey(docId, c.index), `${c.heading}\n${c.text}`);
        this.track(
          this.vectors.add({
            id: chunkKey(docId, c.index),
            text: `${c.heading}\n${c.text}`,
            metadata: c.metadata,
          }),
        );
      }
    }
  }

  /** Ingest (or atomically replace) a document: chunk → index → persist. */
  async ingest(doc: IngestDoc): Promise<number> {
    const old = this.docs.get(doc.id);
    if (old) {
      for (const c of old) {
        this.bm25.remove(chunkKey(doc.id, c.index));
        void this.vectors.purge((r) => r.id === chunkKey(doc.id, c.index));
      }
    }
    const opts: { maxChars?: number; overlapChars?: number } = {};
    if (this.maxChars !== undefined) opts.maxChars = this.maxChars;
    if (this.overlapChars !== undefined) opts.overlapChars = this.overlapChars;
    const chunks = chunkDocument(doc, opts);
    this.docs.set(doc.id, chunks);
    for (const c of chunks) {
      this.bm25.add(chunkKey(doc.id, c.index), `${c.heading}\n${c.text}`);
      this.track(
        this.vectors.add({
          id: chunkKey(doc.id, c.index),
          text: `${c.heading}\n${c.text}`,
          metadata: c.metadata,
        }),
      );
    }
    this.persist();
    return chunks.length;
  }

  /** Remove every chunk of a document. Returns how many were removed. */
  async deleteDoc(docId: string): Promise<number> {
    const old = this.docs.get(docId);
    if (!old) return 0;
    for (const c of old) {
      this.bm25.remove(chunkKey(docId, c.index));
      this.track(this.vectors.purge((r) => r.id === chunkKey(docId, c.index)));
    }
    this.docs.delete(docId);
    this.persist();
    return old.length;
  }

  size(): number {
    let n = 0;
    for (const chunks of this.docs.values()) n += chunks.length;
    return n;
  }

  docIds(): string[] {
    return [...this.docs.keys()].sort();
  }

  /** Re-embed every chunk under the vector store's current embedder — the
   *  one-time migration after swapping embedding backends. Documents and the
   *  BM25 index are untouched; snapshots persist through the store's add(). */
  async reindex(): Promise<number> {
    let n = 0;
    for (const [docId, chunks] of this.docs) {
      for (const c of chunks) {
        await this.vectors.add({ id: chunkKey(docId, c.index), text: `${c.heading}\n${c.text}`, metadata: c.metadata });
        n += 1;
      }
    }
    return n;
  }

  /**
   * Hybrid search: BM25 + vector candidates → RRF fusion → re-rank → top-K.
   * Metadata filters apply BEFORE scoring (pre-filter, per the skill).
   */
  async search(query: string, opts: SearchOptions = {}): Promise<KnowledgeHit[]> {
    // Async embedders index concurrently with callers: settle the in-flight
    // backlog so the vector signal is actually present (the boot-race guard).
    await this.settle();
    const topK = opts.topK ?? 5;
    const minScore = opts.minScore ?? 0.05;
    const where = opts.where;
    const allowed = new Set(
      [...this.docs.entries()]
        .flatMap(([docId, chunks]) => chunks.filter((c) => matchesWhere(c, where)).map((c) => chunkKey(docId, c.index)))
    );
    if (allowed.size === 0) return [];

    // Signal 1: BM25 lexical.
    const lexical = this.bm25
      .score(query)
      .filter((r) => allowed.has(r.id))
      .slice(0, CANDIDATE_K);

    // Signal 2: cosine over the vector index.
    const vectorHits = await this.vectors.search(query, this.vectors.size(), 0);
    const vector = vectorHits.filter((h) => allowed.has(h.id)).slice(0, CANDIDATE_K);

    // Reciprocal-rank fusion over the union of both candidate pools.
    const fused = new Map<string, number>();
    const vectorSim = new Map<string, number>();
    lexical.forEach((r, i) => fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));
    vector.forEach((h, i) => {
      fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (RRF_K + i + 1));
      vectorSim.set(h.id, Math.max(vectorSim.get(h.id) ?? 0, h.score));
    });

    const candidates = [...fused.entries()]
      .map(([id, s]) => ({ id, fusedScore: s, vectorScore: vectorSim.get(id) ?? 0 }))
      .sort((a, b) => b.fusedScore - a.fusedScore);

    // Deterministic second-pass re-rank over the fused candidates (the
    // cross-encoder stand-in; swap for a real model behind this seam later).
    const chunkById = new Map<string, Chunk>();
    for (const [docId, chunks] of this.docs) for (const c of chunks) chunkById.set(chunkKey(docId, c.index), c);

    const reranked = candidates
      .map(({ id, fusedScore, vectorScore }) => {
        const chunk = chunkById.get(id);
        if (!chunk) return undefined;
        const score = rerankScore(query, chunk, { vectorScore, fusedScore });
        return { chunk, score };
      })
      .filter((x): x is { chunk: Chunk; score: number } => x !== undefined)
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return reranked.map(({ chunk, score }) => ({ ...chunk, score }));
  }
}

function chunkKey(docId: string, index: number): string {
  return `${docId}#${index}`;
}

function matchesWhere(chunk: Chunk, where: SearchOptions['where']): boolean {
  if (!where) return true;
  const meta = chunk.metadata ?? {};
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;
    if (key === 'tags') {
      const tags = Array.isArray(meta['tags']) ? (meta['tags'] as unknown[]) : [];
      const wanted = Array.isArray(expected) ? expected : [expected];
      const has = (wanted as unknown[]).every((t) => tags.includes(t));
      if (!has) return false;
      continue;
    }
    if (meta[key] !== expected) return false;
  }
  return true;
}

/**
 * Deterministic re-rank: the vector similarity is the BASE (a zero-lexical-
 * overlap paraphrase must survive — that is the case hybrid retrieval exists
 * for); term coverage and density are boosts that lift exact-term chunks
 * above pure-vector ones; the fused rank breaks ties. A real cross-encoder
 * replaces this body behind the same call site.
 */
function rerankScore(
  query: string,
  chunk: Chunk,
  signals: { vectorScore: number; fusedScore: number },
): number {
  const qTerms = [...new Set(tokenizeBm25(query))];
  if (qTerms.length === 0) return signals.vectorScore + 0.1 * signals.fusedScore;
  const text = `${chunk.heading}\n${chunk.text}`;
  const tokens = tokenizeBm25(text);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let covered = 0;
  let density = 0;
  for (const t of qTerms) {
    const tf = counts.get(t) ?? 0;
    if (tf > 0) covered += 1;
    density += tf;
  }
  const coverage = covered / qTerms.length;
  const densityNorm = density / (tokens.length + 1);
  return signals.vectorScore + 0.5 * coverage + 0.25 * densityNorm + 0.1 * signals.fusedScore;
}

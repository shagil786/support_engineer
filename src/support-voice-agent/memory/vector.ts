/** Layer 1 — vector/RAG memory port + dependency-free implementation.
 *
 *  Embeddings come from an injected `Embedder`. The default `HashEmbedder`
 *  is a deterministic, keyless hashing bag-of-words — good enough for runbook
 *  and incident-note retrieval, and swappable for a real cloud embedding API
 *  or Pinecone behind the same `VectorMemory` port later.
 */

export type Embedder = (text: string) => number[];

/** Deterministic 256-dim hashed features: word tokens, bigrams, and
 *  character trigrams (so "payments"≈"payment", "timeout"≈"timeouts").
 *  Deliberately keyless and dependency-free — swap for a real embedding
 *  API behind the same `Embedder` type when the cloud LLM is configured. */
export const hashEmbedder: Embedder = (() => {
  const DIM = 256;
  const STOP = new Set(['a','an','and','are','as','at','be','but','by','can','did','do','does','for','from','had','has','have','how','i','if','in','is','it','its','me','my','no','not','of','on','or','so','than','that','the','their','them','then','there','they','this','to','was','we','were','what','when','where','which','who','why','will','with','you','your','just','please','about','now']);
  const tokenize = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 0 && !STOP.has(w));
  const hash = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % DIM;
  };
  return (text: string): number[] => {
    const vec = new Array<number>(DIM).fill(0);
    const bump = (f: string, w: number) => { vec[hash(f)] = (vec[hash(f)] ?? 0) + w; };
    const tokens = tokenize(text);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i] as string;
      bump(tok, 2); // exact token is the strongest signal
      const padded = `#${tok}#`;
      for (let j = 0; j < padded.length - 2; j++) bump(padded.slice(j, j + 3), 1);
      const next = tokens[i + 1];
      if (next) bump(`${tok}_${next}`, 1);
    }
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  };
})();

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export interface MemoryRecord {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SearchHit extends MemoryRecord {
  score: number;
}

/** Retrieval-augmented memory port. Implementations: in-memory now,
 *  Pinecone/pgvector later — same interface. */
export interface VectorMemory {
  add(record: MemoryRecord): Promise<void>;
  search(query: string, topK?: number, minScore?: number): Promise<SearchHit[]>;
  size(): number;
}

export class InMemoryVectorMemory implements VectorMemory {
  private readonly entries: Array<{ record: MemoryRecord; vector: number[] }> = [];
  private readonly embed: Embedder;

  constructor(opts: { embedder?: Embedder } = {}) {
    this.embed = opts.embedder ?? hashEmbedder;
  }

  async add(record: MemoryRecord): Promise<void> {
    const existing = this.entries.findIndex((e) => e.record.id === record.id);
    const entry = { record, vector: this.embed(record.text) };
    if (existing >= 0) this.entries[existing] = entry;
    else this.entries.push(entry);
  }

  async search(query: string, topK = 3, minScore = 0.05): Promise<SearchHit[]> {
    if (this.entries.length === 0) return [];
    const q = this.embed(query);
    return this.entries
      .map((e) => ({ ...e.record, score: cosine(q, e.vector) }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  size(): number {
    return this.entries.length;
  }
}

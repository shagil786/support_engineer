/**
 * Okapi BM25 — the lexical half of hybrid retrieval (rag-engineering skill:
 * "combine vector similarity with keyword search"). Dependency-free and
 * deterministic; tokenization deliberately matches the hash embedder's
 * (lowercase, strip punctuation, shared stopword list) so both signals score
 * the same token stream.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a','an','and','are','as','at','be','but','by','can','did','do','does','for','from','had','has','have','how','i','if','in','is','it','its','me','my','no','not','of','on','or','so','than','that','the','their','them','then','there','they','this','to','was','we','were','what','when','where','which','who','why','will','with','you','your','just','please','about','now',
]);

export function tokenizeBm25(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

const K1 = 1.2;
const B = 0.75;

/** One BM25 scoring index over a static doc set; add/remove rebuild df. */
export class Bm25Index {
  private readonly docs: Array<{ id: string; tokens: string[]; len: number }> = [];
  private readonly df = new Map<string, number>();

  add(id: string, text: string): void {
    this.remove(id);
    const tokens = tokenizeBm25(text);
    this.docs.push({ id, tokens, len: tokens.length });
    this.rebuildDf();
  }

  remove(id: string): void {
    const i = this.docs.findIndex((d) => d.id === id);
    if (i >= 0) {
      this.docs.splice(i, 1);
      this.rebuildDf();
    }
  }

  size(): number {
    return this.docs.length;
  }

  private rebuildDf(): void {
    this.df.clear();
    for (const d of this.docs) {
      for (const t of new Set(d.tokens)) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
  }

  /** BM25 scores for `query` against every indexed doc, best first. */
  score(query: string): Array<{ id: string; score: number }> {
    const qTokens = tokenizeBm25(query);
    const N = this.docs.length;
    if (N === 0 || qTokens.length === 0) return [];
    const avgdl = this.docs.reduce((a, d) => a + d.len, 0) / N;
    const results: Array<{ id: string; score: number }> = [];
    for (const d of this.docs) {
      let s = 0;
      for (const t of qTokens) {
        const tf = d.tokens.reduce((a, x) => (x === t ? a + 1 : a), 0);
        if (tf === 0) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + B * (d.len / avgdl)));
      }
      if (s > 0) results.push({ id: d.id, score: s });
    }
    return results.sort((a, b) => b.score - a.score);
  }
}

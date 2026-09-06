/**
 * OpenAI-compatible embedder (rag-engineering skill: "cache embeddings",
 * "choose embedding models matched to your content") — the real backend for
 * the `Embedder` port. Hits `<baseUrl>/embeddings`, batches inputs, caches
 * per (model, text), L2-normalizes so cosine similarity stays a dot product,
 * and maps failures to `EmbeddingError` (degradation stays honest: network
 * errors are thrown, never silently zeroed).
 *
 * `dim` truncation: remote models can exceed local dimension assumptions
 * (e.g. 256-dim snapshots). When `dim` is set and the model returns more,
 * vectors are folded down by a deterministic modular projection — same input
 * always yields the same reduced vector, so snapshots stay stable.
 *
 * `hashEmbedderCompat` re-exports the built-in as an `AsyncEmbedder` so the
 * two backends are interchangeable wherever an async embedder is accepted.
 */
import { hashEmbedder } from '../vector.js';

export type AsyncEmbedder = (text: string) => Promise<number[]>;

export class EmbeddingError extends Error {
  constructor(
    public readonly code: 'unwired' | 'network' | 'http_error' | 'malformed',
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface OpenAiCompatibleEmbedderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Fold longer vectors down to this dimension (deterministic projection). */
  dim?: number;
  /** Batch size for embedBatch requests (default 64). */
  batchSize?: number;
  timeoutMs?: number;
  /** Injectable fetch for tests / proxies. */
  request?: typeof fetch;
}

/** Fold a vector to `dim` by modular binning: deterministic and order-stable. */
export function mapToDim(v: number[], dim: number): number[] {
  if (dim >= v.length) return [...v];
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x !== undefined) out[i % dim] = (out[i % dim] ?? 0) + x;
  }
  return out;
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Validate one embeddings-API row and return its vector. */
export function extractEmbedding(body: unknown, index: number): number[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new EmbeddingError('malformed', 'embeddings response missing data array', body);
  const row = data[index] as { embedding?: unknown; index?: unknown } | undefined;
  const emb = row?.embedding;
  if (!Array.isArray(emb) || emb.length === 0 || !emb.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new EmbeddingError('malformed', `embeddings response row ${index} has no valid embedding`, row);
  }
  return emb;
}

export class OpenAiCompatibleEmbedder {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dim: number | undefined;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly http: typeof fetch;
  private readonly cache = new Map<string, number[]>();

  constructor(opts: OpenAiCompatibleEmbedderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dim = opts.dim;
    this.batchSize = opts.batchSize ?? 64;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.http = opts.request ?? fetch;
  }

  isWired(): boolean {
    return this.apiKey.length > 0 && this.baseUrl.length > 0 && this.model.length > 0;
  }

  /** Single-text convenience over embedBatch. */
  embed = async (text: string): Promise<number[]> => {
    const [v] = await this.embedBatch([text]);
    return v as number[];
  };

  /** Embed a batch: cache lookups first, one HTTP call per uncached window. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) throw new EmbeddingError('malformed', 'embedBatch requires a non-empty input batch');
    if (!this.isWired()) throw new EmbeddingError('unwired', 'embedder not configured — set EMBEDDINGS_BASE_URL, EMBEDDINGS_API_KEY, EMBEDDINGS_MODEL');

    const out = new Array<number[] | undefined>(texts.length);
    const missing: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i] ?? '';
      const hit = this.cache.get(`${this.model}\u0000${t}`);
      if (hit) out[i] = hit;
      else missing.push(i);
    }

    for (let start = 0; start < missing.length; start += this.batchSize) {
      const window = missing.slice(start, start + this.batchSize);
      const inputs = window.map((i) => texts[i] ?? '');
      const vectors = await this.requestBatch(inputs);
      for (let j = 0; j < window.length; j++) {
        const idx = window[j] as number;
        const raw = vectors[j] as number[];
        const folded = this.dim !== undefined ? mapToDim(raw, this.dim) : raw;
        const v = normalize(folded);
        this.cache.set(`${this.model}\u0000${texts[idx] ?? ''}`, v);
        out[idx] = v;
      }
    }
    return out as number[][];
  }

  private async requestBatch(inputs: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: inputs }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new EmbeddingError('network', 'embeddings request timed out');
      }
      throw new EmbeddingError('network', 'embeddings request failed', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let detail: unknown;
      try {
        detail = await response.json();
      } catch {
        detail = await response.text().catch(() => 'no body');
      }
      throw new EmbeddingError('http_error', `embeddings HTTP ${response.status}`, detail);
    }
    const body: unknown = await response.json().catch(() => {
      throw new EmbeddingError('malformed', 'embeddings response was not JSON');
    });
    return inputs.map((_, i) => extractEmbedding(body, i));
  }
}

/** The built-in hash embedder behind the async port (test/dev + default). */
export async function hashEmbedderCompat(text: string): Promise<number[]> {
  return hashEmbedder(text);
}

/**
 * LocalEmbedder — real semantic embeddings, in-process (rag-engineering
 * skill: "choose embedding models matched to your content"), with no API,
 * no key, and no second provider: transformers.js running a sentence
 * transformer locally. Default model: all-MiniLM-L6-v2 (384-dim, the
 * sentence-similarity workhorse).
 *
 * Design mirrors OpenAiCompatibleEmbedder so backends stay interchangeable
 * behind the `EmbedderLike` port: per-text caching, batching, deterministic
 * `dim` folding via mapToDim, L2 normalization, and honest failures — a
 * model-load error is `EmbeddingError('model_load')`, never a silent zero
 * vector.
 *
 * The pipeline is LAZY: constructed on first embed, exactly once, and the
 * transformers.js module is dynamically imported inside the default factory
 * so processes that never embed pay nothing at startup. Tests inject a
 * fake factory and never touch the network or the ~25MB model download.
 */
import { EmbeddingError, mapToDim, normalize, type AsyncEmbedder } from './openai.js';

export const DEFAULT_LOCAL_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Minimal structural types over transformers.js's tensor (kept structural
 *  so tests can fake it without the real module installed). */
export interface TensorLike {
  dims: number[];
  data: Float32Array | number[];
}

/** A feature-extraction pipeline: (texts, pooling opts) → batched tensor. */
export type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => TensorLike | Promise<TensorLike>;

/** Quantization options transformers.js accepts for pipeline dtype. */
export type PipelineDtype = 'auto' | 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4';

/** Constructs the pipeline (task, model id, quantization options). */
export type PipelineFactory = (
  task: 'feature-extraction',
  model: string,
  opts?: { dtype?: PipelineDtype },
) => Promise<FeatureExtractor>;

export interface LocalEmbedderOptions {
  /** HF model id (default Xenova/all-MiniLM-L6-v2, 384-dim). */
  model?: string;
  /** Fold longer vectors down to this dimension (deterministic projection). */
  dim?: number;
  /** Batch size for embedBatch (default 32 — local inference is CPU-bound). */
  batchSize?: number;
  /** Injectable pipeline constructor (tests / alternate runtimes). */
  pipeline?: PipelineFactory;
}

/** Default factory: dynamic import keeps startup free for non-embedding paths. */
const defaultPipelineFactory: PipelineFactory = async (task, model, opts) => {
  const mod = await import('@huggingface/transformers');
  return mod.pipeline(task, model, opts) as Promise<FeatureExtractor>;
};

export class LocalEmbedder {
  readonly model: string;
  private readonly dim: number | undefined;
  private readonly batchSize: number;
  private readonly makePipeline: PipelineFactory;
  private readonly cache = new Map<string, number[]>();
  private extractor: FeatureExtractor | undefined;
  private loading: Promise<FeatureExtractor> | undefined;

  constructor(opts: LocalEmbedderOptions = {}) {
    this.model = opts.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
    this.dim = opts.dim;
    this.batchSize = opts.batchSize ?? 32;
    this.makePipeline = opts.pipeline ?? defaultPipelineFactory;
    this.embed = Object.assign(async (text: string): Promise<number[]> => {
      const [v] = await this.embedBatch([text]);
      return v as number[];
    }, { identity: `local:${this.model}${this.dim !== undefined ? `@${this.dim}` : ''}` });
  }

  /** Local backends are always "wired" — the model loads on first use. */
  isWired(): boolean {
    return true;
  }

  /** Single-text convenience over embedBatch. Carries the stable model
   *  identity so durable stores can detect a same-dim model swap. Assigned
   *  in the constructor (identity needs model/dim, which field initializers
   *  cannot see yet). */
  embed: AsyncEmbedder;

  /** Embed a batch: cache lookups first, one inference call per uncached window. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) throw new EmbeddingError('malformed', 'embedBatch requires a non-empty input batch');

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
      const vectors = await this.vectorize(inputs);
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

  /** One pipeline call for the window; failures map to EmbeddingError. */
  private async vectorize(inputs: string[]): Promise<number[][]> {
    const extractor = await this.getExtractor();
    let tensor: TensorLike;
    try {
      tensor = await extractor(inputs, { pooling: 'mean', normalize: true });
    } catch (e) {
      throw new EmbeddingError('inference', 'local embedding inference failed', e instanceof Error ? e.message : String(e));
    }
    const [batch, hidden] = tensor.dims;
    if (typeof batch !== 'number' || typeof hidden !== 'number' || batch !== inputs.length) {
      throw new EmbeddingError('malformed', `unexpected tensor shape for batch of ${inputs.length}: [${tensor.dims.join(', ')}]`);
    }
    const data = tensor.data;
    const rows: number[][] = [];
    for (let i = 0; i < batch; i++) {
      const row: number[] = [];
      for (let j = 0; j < hidden; j++) row.push(data[i * hidden + j] as number);
      rows.push(row);
    }
    return rows;
  }

  /** Lazy singleton pipeline: first embed constructs it, exactly once. A
   *  failed load clears the promise so a retry can actually retry. */
  private async getExtractor(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = this.makePipeline('feature-extraction', this.model, { dtype: 'q8' })
        .then((p) => {
          this.extractor = p;
          return p;
        })
        .catch((e: unknown) => {
          this.loading = undefined;
          throw new EmbeddingError('model_load', `local embedding model failed to load (${this.model})`, e instanceof Error ? e.message : String(e));
        });
    }
    return this.loading;
  }
}

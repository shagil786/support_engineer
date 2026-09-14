/**
 * Shared embedder factory — the single place an `IntegrationsFromEnv['embeddings']`
 * config becomes an embedder. Bootstrap, the knowledge CLI, and both eval
 * scripts construct through this so every surface honors the same
 * EMBEDDINGS_* contract (and a migrated KB is queried with vectors from the
 * SAME backend that produced it — mixing backends silently would corrupt
 * retrieval).
 *
 * `undefined` config → `undefined` embedder: the caller decides the default
 * (the KB/store falls back to the built-in hash embedder).
 *
 * `local` IS the built-in hash embedder (2026-09-14 decision): deterministic,
 * keyless, dependency-free, in-process. The former transformers.js ONNX
 * backend was removed — its `@huggingface/transformers` → `onnxruntime-node`
 * chain carried unfixable high-severity advisories (adm-zip, sharp/libvips)
 * that npm audit flagged on every install. Operators who need true semantic
 * similarity point EMBEDDINGS_PROVIDER=remote at any OpenAI-compatible
 * /embeddings endpoint.
 */
import type { IntegrationsFromEnv } from '../../../config.js';
import type { EmbedderLike } from '../vector.js';
import { hashEmbedder } from '../vector.js';
import { OpenAiCompatibleEmbedder } from './openai.js';

export type EmbeddingsConfig = NonNullable<IntegrationsFromEnv['embeddings']>;

export interface EmbedderFactoryOptions {
  /** Injectable fetch for tests / proxies (remote backend only). */
  request?: typeof fetch;
}

export function embedderFromConfig(
  config: EmbeddingsConfig | undefined,
  opts: EmbedderFactoryOptions = {},
): EmbedderLike | undefined {
  if (!config) return undefined;
  if (config.provider === 'local') {
    // Fresh async wrapper per call (never mutate the shared export), carrying
    // the SAME identity as the built-in hash default — the vectors are byte-
    // identical, so flipping a deployment between absent and explicit `local`
    // config must not invalidate persisted stores.
    return Object.assign((text: string) => Promise.resolve(hashEmbedder(text)), {
      identity: (hashEmbedder as EmbedderLike).identity,
    });
  }
  return new OpenAiCompatibleEmbedder({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    ...(config.dim !== undefined ? { dim: config.dim } : {}),
    ...(opts.request ? { request: opts.request } : {}),
  }).embed;
}

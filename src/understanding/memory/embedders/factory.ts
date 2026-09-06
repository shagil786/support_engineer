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
 */
import type { IntegrationsFromEnv } from '../../../config.js';
import type { EmbedderLike } from '../vector.js';
import { OpenAiCompatibleEmbedder } from './openai.js';
import { LocalEmbedder, type PipelineFactory } from './local.js';

export type EmbeddingsConfig = NonNullable<IntegrationsFromEnv['embeddings']>;

export interface EmbedderFactoryOptions {
  /** Injectable fetch for tests / proxies (remote backend only). */
  request?: typeof fetch;
  /** Injectable pipeline constructor for tests (local backend only). */
  pipeline?: PipelineFactory;
}

export function embedderFromConfig(
  config: EmbeddingsConfig | undefined,
  opts: EmbedderFactoryOptions = {},
): EmbedderLike | undefined {
  if (!config) return undefined;
  if (config.provider === 'local') {
    return new LocalEmbedder({
      ...(config.model ? { model: config.model } : {}),
      ...(config.dim !== undefined ? { dim: config.dim } : {}),
      ...(opts.pipeline ? { pipeline: opts.pipeline } : {}),
    }).embed;
  }
  return new OpenAiCompatibleEmbedder({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    ...(config.dim !== undefined ? { dim: config.dim } : {}),
    ...(opts.request ? { request: opts.request } : {}),
  }).embed;
}

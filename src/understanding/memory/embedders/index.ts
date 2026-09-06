/** Embedder registry. v1 ships only the hash embedder; cloud embedders
 *  (OpenAI, Bedrock, …) plug in here behind the same `Embedder` type. */
import type { Embedder } from '../vector.js';
import { hashEmbedder } from './hash.js';

export const EMBEDDERS: Record<string, Embedder> = {
  hash: hashEmbedder,
};

export function resolveEmbedder(name: string): Embedder {
  const e = EMBEDDERS[name];
  if (!e) throw new Error(`Unknown embedder: ${name} (known: ${Object.keys(EMBEDDERS).join(', ')})`);
  return e;
}

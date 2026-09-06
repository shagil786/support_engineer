export { IntentClassifier, type IntentClassifierOptions } from './intent-classifier.js';
export { LegacyClassifierAdapter, type ClassifyInput, type ClassifySource } from './legacy/classifier-adapter.js';
export { ContextAssembler, type ContextBundle, type AssembleOptions, type ContextAssemblerOptions } from './context-assembler.js';
export { EpisodicMemory, type EpisodicScope, type EpisodicMemoryOptions, type RecordOptions } from './memory/episodic.js';
export * from './memory/kv.js';
export * from './memory/vector.js';
export { resolveEmbedder, EMBEDDERS } from './memory/embedders/index.js';
export {
  OpenAiCompatibleEmbedder,
  EmbeddingError,
  extractEmbedding,
  mapToDim,
  normalize,
  hashEmbedderCompat,
  type AsyncEmbedder,
  type OpenAiCompatibleEmbedderOptions,
} from './memory/embedders/openai.js';

/**
 * Builds the ContextBundle Execution consumes (spec §4.1). Composes:
 *  - the IntentEnvelope from the Understanding layer
 *  - top-K episodes from EpisodicMemory.recall()
 *  - recent DecisionEvents (sliding window from the EventLog)
 *  - knowledge hits from the hybrid KnowledgeBase (when wired), each carrying
 *    full provenance (docId, index, heading, metadata) for the citation layer
 *
 * The assembler describes context only — it never calls tools or decides
 * policy.
 */
import type { IntentEnvelope, DecisionEvent } from '../event-log/types.js';
import type { EpisodicMemory, EpisodicScope } from './memory/episodic.js';
import type { SearchHit } from './memory/vector.js';
import type { FileBackedKnowledgeBase, KnowledgeHit, SearchOptions } from './knowledge/knowledge-base.js';

export interface ContextBundle {
  envelope: IntentEnvelope;
  episodes: SearchHit[];
  recent: DecisionEvent[];
  /** Hybrid-retrieval hits from the knowledge base; present only when a KB
   *  is wired at construction. Provenance travels with every hit. */
  knowledge?: KnowledgeHit[];
}

export interface AssembleOptions {
  envelope: IntentEnvelope;
  recent?: DecisionEvent[];
  /** Free-text recall query; defaults to entities then the intent kind. */
  text?: string;
  topK?: number;
  minScore?: number;
  scope?: EpisodicScope;
  /** Override the metadata filter for knowledge retrieval (e.g. restrict to
   *  source: 'runbooks'). Defaults to no filter. */
  knowledgeWhere?: SearchOptions['where'];
}

export interface ContextAssemblerOptions {
  episodic: EpisodicMemory;
  /** Optional hybrid knowledge base; unwired → no `knowledge` field. */
  knowledge?: FileBackedKnowledgeBase;
}

export class ContextAssembler {
  private readonly knowledge?: FileBackedKnowledgeBase;
  constructor(private readonly opts: ContextAssemblerOptions) {
    this.knowledge = opts.knowledge;
  }

  async assemble(input: AssembleOptions): Promise<ContextBundle> {
    const query = input.text ?? this.intentToQuery(input.envelope);
    const scope: EpisodicScope = input.scope ?? 'cross';
    const episodes = await this.opts.episodic.recall(scope, query, input.topK ?? 5, input.minScore ?? 0.3);

    const knowledge = this.knowledge
      ? await this.knowledge.search(query, {
          topK: input.topK ?? 5,
          ...(input.knowledgeWhere ? { where: input.knowledgeWhere } : {}),
        })
      : undefined;

    return {
      envelope: input.envelope,
      episodes,
      recent: input.recent ?? [],
      ...(knowledge !== undefined ? { knowledge } : {}),
    };
  }

  private intentToQuery(env: IntentEnvelope): string {
    if (env.entities.ticketKeys?.length) return env.entities.ticketKeys.join(' ');
    if (env.entities.runbookIds?.length) return env.entities.runbookIds.join(' ');
    return env.intent.kind === 'unknown' ? '' : env.intent.subKind;
  }
}

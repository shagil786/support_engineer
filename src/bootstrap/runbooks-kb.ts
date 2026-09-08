/** The runbook catalog as knowledge-base documents.
 *
 * A RunbookAction is execution config (what the agent may offer/execute);
 * the same catalog doubles as retrieval content so the KB-first path answers
 * "how do I restart the checkout pod" from the actions this platform can
 * actually perform — no separate manual ingest step. Docs are namespaced
 * `runbook:<id>` and kept in sync with the live catalog: re-ingest replaces
 * atomically (the KB is replace-by-doc-id), and docs left over from a
 * shrunken catalog are evicted so the KB never answers from an action the
 * platform no longer offers.
 */
import type { RunbookAction } from '../support-voice-agent/integrations/runbook.js';
import type { IngestDoc } from '../understanding/knowledge/chunker.js';
import type { FileBackedKnowledgeBase } from '../understanding/knowledge/knowledge-base.js';

/** Doc-id namespace for catalog-derived docs. Platform-owned: any doc under
 *  this prefix that is not in the current catalog is evicted on sync. */
export const RUNBOOK_DOC_PREFIX = 'runbook:';

export function runbookDocId(actionId: string): string {
  return `${RUNBOOK_DOC_PREFIX}${actionId}`;
}

/** One KB doc per catalog action: the action name is the chunk heading (the
 *  retrieval unit), the body is the offer verb phrase plus id and approval
 *  posture — exactly the terms a "how do I…" question uses. */
export function runbookToDoc(action: RunbookAction): IngestDoc {
  return {
    id: runbookDocId(action.id),
    text: [
      `# ${action.name}`,
      `Runbook action: ${action.description}.`,
      `Action id: ${action.id}. ${action.destructive ? 'Destructive: always requires explicit human approval before execution.' : 'Non-destructive.'}`,
    ].join('\n'),
    metadata: {
      source: 'runbooks',
      runbookId: action.id,
      destructive: action.destructive,
      tags: action.id.split(/[^a-zA-Z0-9]+/).filter((t) => t.length > 0),
    },
  };
}

export interface RunbookSyncResult {
  /** Ingest/evict promises; the KB bodies are synchronous, so all settle on
   *  the next microtask — returned for readiness surfaces to await. */
  ops: Promise<unknown>[];
  synced: number;
  evicted: number;
}

/** Bring the KB back to the catalog (and the catalog into the KB): ingest
 *  every current action, evict `runbook:`-prefixed docs whose action left
 *  the catalog. Idempotent — safe to run on every boot. */
export function syncRunbooksToKnowledge(
  knowledge: FileBackedKnowledgeBase,
  catalog: RunbookAction[],
): RunbookSyncResult {
  const wanted = new Set(catalog.map((a) => runbookDocId(a.id)));
  const ops: Promise<unknown>[] = [];
  let evicted = 0;
  for (const docId of knowledge.docIds()) {
    if (docId.startsWith(RUNBOOK_DOC_PREFIX) && !wanted.has(docId)) {
      ops.push(knowledge.deleteDoc(docId));
      evicted += 1;
    }
  }
  for (const action of catalog) ops.push(knowledge.ingest(runbookToDoc(action)));
  return { ops, synced: catalog.length, evicted };
}
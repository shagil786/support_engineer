import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform, type Platform } from '../../src/bootstrap';
import { RUNBOOK_DOC_PREFIX, runbookDocId, runbookToDoc, syncRunbooksToKnowledge } from '../../src/bootstrap/runbooks-kb';
import { FileBackedKnowledgeBase } from '../../src/understanding/knowledge/knowledge-base';
import { runbooksFromFile } from '../../src/config';
import { writeFileSync, existsSync } from 'node:fs';
import { JsonlFileEventLog } from '../../src/event-log/log';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runbooks-kb-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const catalog = [
  { id: 'restart-checkout-pod', name: 'Restart checkout pod', description: 'restart the checkout pod', destructive: false },
  { id: 'drain-pool', name: 'Drain connection pool', description: 'drain and restart the connection pool', destructive: true },
];

describe('runbook catalog as knowledge', () => {
  it('createPlatform auto-ingests the catalog; a KB-first question answers from it', async () => {
    const p = createPlatform({ dataDir: dir, runbooks: catalog });
    await p.ready();
    const ids = p.knowledge.docIds();
    expect(ids).toContain('runbook:restart-checkout-pod');
    expect(ids).toContain('runbook:drain-pool');

    const hits = await p.knowledge.search('how do I restart the checkout pod');
    expect(hits[0]?.docId).toBe('runbook:restart-checkout-pod');
    expect(hits[0]?.metadata?.['source']).toBe('runbooks');
    expect(hits[0]?.metadata?.['destructive']).toBe(false);
  });

  it('a live telemetry question is never answered from the static catalog', async () => {
    // Regression: with the catalog in the KB, "check the error logs for the
    // api" is lexically close to "clear the api cache" — the live-data gate
    // (now on the deterministic floor too) must keep it on the governed
    // logs path instead of answering from the catalog.
    const p = createPlatform({ dataDir: dir, runbooks: catalog });
    const r = await p.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.answerSource).not.toBe('knowledge');
  });

  it('destructive actions are described with their approval posture', async () => {
    const p = createPlatform({ dataDir: dir, runbooks: catalog });
    await p.ready();
    const hits = await p.knowledge.search('drain the connection pool');
    expect(hits[0]?.docId).toBe('runbook:drain-pool');
    expect(hits[0]?.text).toMatch(/requires explicit human approval/i);
  });

  it('re-sync is idempotent and eviction removes docs for actions that left the catalog', async () => {
    const p = createPlatform({ dataDir: dir, runbooks: catalog });
    await p.ready();
    expect(p.knowledge.docIds().filter((id) => id.startsWith(RUNBOOK_DOC_PREFIX))).toHaveLength(2);

    // Shrink the catalog: restart-checkout-pod leaves, manual docs survive.
    const p2 = createPlatform({
      dataDir: dir,
      runbooks: [catalog[1]!],
    });
    await p2.ready();
    const ids = p2.knowledge.docIds();
    expect(ids).not.toContain('runbook:restart-checkout-pod');
    expect(ids).toContain('runbook:drain-pool');
  });

  it('syncRunbooksToKnowledge is idempotent on a standalone KB (ingest replaces by doc id)', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(dir, 'kb.json') });
    syncRunbooksToKnowledge(kb, catalog);
    await Promise.all(syncRunbooksToKnowledge(kb, catalog).ops);
    const first = await kb.search('drain the connection pool');
    expect(first[0]?.docId).toBe('runbook:drain-pool');
    // No duplicate-doc drift: exactly one doc per action.
    expect(kb.docIds().filter((id) => id.startsWith(RUNBOOK_DOC_PREFIX))).toHaveLength(2);
  });

  it('runbookToDoc shapes provenance metadata (source, id, destructive, tags)', () => {
    const doc = runbookToDoc(catalog[0]!);
    expect(doc.id).toBe('runbook:restart-checkout-pod');
    expect(doc.metadata?.['source']).toBe('runbooks');
    expect(doc.metadata?.['runbookId']).toBe('restart-checkout-pod');
    expect(doc.metadata?.['destructive']).toBe(false);
    expect(doc.metadata?.['tags']).toContain('checkout');
  });

  it('a RUNBOOKS_FILE catalog syncs through the same path (config → CLI parity)', async () => {
    const file = join(dir, 'runbooks.json');
    writeFileSync(file, JSON.stringify(catalog));
    const actions = runbooksFromFile(file);
    const kb = new FileBackedKnowledgeBase({ path: join(dir, 'kb.json') });
    const { synced, evicted } = syncRunbooksToKnowledge(kb, actions);
    await Promise.all(syncRunbooksToKnowledge(kb, actions).ops);
    expect(synced).toBe(2);
    expect(evicted).toBe(0);
    expect(kb.docIds()).toContain(runbookDocId('drain-pool'));
  });

  it('end to end: a how-to question through the pipeline is answered, cited and sourced from the auto-ingested catalog', async () => {
    const spoken: string[] = [];
    const p: Platform = createPlatform({
      dataDir: dir,
      runbooks: catalog,
      deliverSpeech: (text) => spoken.push(text),
    });
    // No manual KB seeding anywhere in this test — the catalog above is the
    // only content, ingested by createPlatform itself.
    expect(p.knowledge.docIds()).toContain('runbook:restart-checkout-pod');

    const r = await p.pipeline.processUtterance('u1', 'agent, how do I restart the checkout pod?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(true);
    expect(r.answerSource).toBe('knowledge');
    // The extractive floor leads with the chunk's own heading — the catalog
    // action's name — and the offer verb phrase, spoken through deliverSpeech.
    expect(r.answer).toMatch(/^Restart checkout pod: /);
    expect(r.answer).toContain('restart the checkout pod');
    expect(spoken).toEqual([r.answer]);

    // The audit trail is the proof of grounding: a grounded_answer event
    // citing the catalog doc ('runbooks' provenance), and NO tool ran.
    const events: Array<Record<string, unknown>> = [];
    for await (const e of (p.eventLog as JsonlFileEventLog).query({ correlationId: r.correlationId })) {
      events.push(e as unknown as Record<string, unknown>);
    }
    const kinds = events.map((e) => e['kind']);
    expect(kinds).toContain('grounded_answer');
    expect(kinds).not.toContain('tool_call');
    expect(kinds).not.toContain('agent_outcome');
    const grounded = events.find((e) => e['kind'] === 'grounded_answer') as
      | { citations: number[]; refused: boolean; sources: Array<{ docId: string; source?: string }> }
      | undefined;
    expect(grounded?.refused).toBe(false);
    expect(grounded?.citations).toEqual([1]);
    expect(grounded?.sources[0]?.docId).toBe('runbook:restart-checkout-pod');
    expect(grounded?.sources[0]?.source).toBe('runbooks');
    // The sync wrote the KB snapshot next to the rest of the runtime data.
    expect(existsSync(join(dir, 'knowledge', 'kb.json'))).toBe(true);
  });
});

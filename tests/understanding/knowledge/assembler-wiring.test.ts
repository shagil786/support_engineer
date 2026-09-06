import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextAssembler } from '../../../src/understanding/context-assembler';
import { EpisodicMemory } from '../../../src/understanding/memory/episodic';
import { FileBackedKnowledgeBase } from '../../../src/understanding/knowledge/knowledge-base';
import type { IntentEnvelope } from '../../../src/event-log/types';
import type { DecisionEvent } from '../../../src/event-log/types';

const envelope = (over: Partial<IntentEnvelope> = {}): IntentEnvelope => ({
  intent: { kind: 'meeting_response', subKind: 'question' },
  confidence: 0.9,
  entities: {},
  rawContext: { source: 'meeting', ts: 0, payload: {} },
  ...over,
});

const recentEvent: DecisionEvent = {
  kind: 'governance',
  correlationId: 'c0',
  ts: 1,
  decision: { effect: 'allow', reason: '', policyIds: [] },
} as unknown as DecisionEvent;

describe('ContextAssembler knowledge wiring', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'asm-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns knowledge hits with provenance when a KB is wired', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    await kb.ingest({
      id: 'run-restart',
      text: '# Checkout restart\nWhen checkout stops responding, restart the pod.',
      metadata: { source: 'runbooks', tags: ['checkout'] },
    });
    const asm = new ContextAssembler({ episodic: new EpisodicMemory(), knowledge: kb });
    const bundle = await asm.assemble({ envelope: envelope({ entities: {} }), text: 'checkout not responding' });
    expect(bundle.knowledge?.length).toBeGreaterThan(0);
    expect(bundle.knowledge?.[0]?.docId).toBe('run-restart');
    expect(bundle.knowledge?.[0]?.heading).toBeTruthy();
    expect(bundle.knowledge?.[0]?.score).toBeGreaterThan(0);
  });

  it('carries no knowledge field when no KB is wired (backward compatible)', async () => {
    const asm = new ContextAssembler({ episodic: new EpisodicMemory() });
    const bundle = await asm.assemble({ envelope: envelope(), text: 'anything' });
    expect(bundle.knowledge).toBeUndefined();
    expect(bundle.episodes).toEqual([]);
    expect(bundle.envelope.confidence).toBe(0.9);
  });

  it('uses the requested topK for knowledge hits', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(root, 'kb.json') });
    await kb.ingest({
      id: 'd',
      text: 'alpha beta\ngamma delta\nepsilon zeta',
    });
    const asm = new ContextAssembler({ episodic: new EpisodicMemory(), knowledge: kb });
    const bundle = await asm.assemble({ envelope: envelope(), text: 'alpha beta', topK: 1 });
    expect(bundle.knowledge?.length).toBe(1);
  });
});

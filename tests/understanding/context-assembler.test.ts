import { describe, it, expect } from 'vitest';
import { ContextAssembler } from '../../src/understanding/context-assembler';
import { EpisodicMemory } from '../../src/understanding/memory/episodic';
import { InMemoryVectorMemory } from '../../src/understanding/memory/vector';
import type { IntentEnvelope, DecisionEvent } from '../../src/event-log/types';

const envelope: IntentEnvelope = {
  intent: { kind: 'meeting_response', subKind: 'runbook_offer' },
  confidence: 0.9,
  entities: { runbookIds: ['restart-checkout-pod'] },
  rawContext: { source: 'meeting', ts: 1, payload: {} },
};

const recent: DecisionEvent[] = [{
  correlationId: 'c1', ts: 1, layer: 'governance', source: 'internal',
  kind: 'governance', intent: envelope,
  decision: { effect: 'allow', reason: 'non-destructive', policyIds: ['runbook_non_destructive_default'] },
}];

describe('ContextAssembler', () => {
  it('builds a bundle from envelope + cross episodes + recent decisions', async () => {
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory() });
    await mem.record('cross', { id: 'p1', text: 'restart-checkout-pod restarts the checkout pod' });
    const ca = new ContextAssembler({ episodic: mem });

    const bundle = await ca.assemble({ envelope, recent });
    expect(bundle.envelope).toBe(envelope);
    expect(bundle.episodes.length).toBeGreaterThan(0);
    expect(bundle.episodes[0]!.id).toBe('p1');
    expect(bundle.recent).toBe(recent);
  });

  it('uses the provided text to drive recall when given', async () => {
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory() });
    await mem.record('cross', { id: 'p1', text: 'checkout pod restart procedure' });
    const ca = new ContextAssembler({ episodic: mem });

    const questionEnv: IntentEnvelope = {
      intent: { kind: 'meeting_response', subKind: 'question' },
      confidence: 1,
      entities: {},
      rawContext: { source: 'meeting', ts: 2, payload: {} },
    };
    const bundle = await ca.assemble({ envelope: questionEnv, text: 'how do I restart the checkout pod' });
    expect(bundle.episodes.length).toBeGreaterThan(0);
    expect(bundle.episodes[0]!.id).toBe('p1');
  });

  it('returns an empty bundle payload when nothing is stored', async () => {
    const ca = new ContextAssembler({ episodic: new EpisodicMemory({ cross: new InMemoryVectorMemory() }) });
    const bundle = await ca.assemble({ envelope });
    expect(bundle.episodes).toEqual([]);
    expect(bundle.recent).toEqual([]);
  });
});

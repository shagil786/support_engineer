import { describe, it, expect } from 'vitest';
import { EvidenceGraph } from '../../src/evidence/graph';
import { rankHypotheses } from '../../src/evidence/hypotheses';

function demoGraph(): EvidenceGraph {
  const g = new EvidenceGraph();
  const t0 = 1_700_000_000_000;
  g.upsert({ id: 'svc:checkout', kind: 'service', label: 'checkout-service' });
  g.upsert({ id: 'svc:payment', kind: 'dependency', label: 'payment-service' });
  g.upsert({ id: 'deploy:v2.41', kind: 'deployment', label: 'deploy v2.41', ts: t0 });
  g.upsert({ id: 'pr:481', kind: 'pr', label: 'PR #481', ts: t0, data: { summary: 'changed timeout handling' } });
  g.upsert({ id: 'trace:failed-91', kind: 'trace', label: 'failed trace sample', ts: t0 + 180_000 });
  g.link({ from: 'svc:checkout', to: 'svc:payment', relation: 'depends_on' });
  g.link({ from: 'svc:checkout', to: 'deploy:v2.41', relation: 'correlated_with' });
  g.link({ from: 'deploy:v2.41', to: 'pr:481', relation: 'references' });
  g.link({ from: 'svc:checkout', to: 'trace:failed-91', relation: 'exhibits', weight: 0.91 });
  g.link({ from: 'pr:481', to: 'deploy:v2.41', relation: 'caused_by', weight: 0.78 });
  return g;
}

describe('EvidenceGraph', () => {
  it('indexes nodes by kind and traverses neighbors', () => {
    const g = demoGraph();
    expect(g.byKind('deployment').map((n) => n.id)).toEqual(['deploy:v2.41']);
    expect(g.neighbors('svc:checkout')).toHaveLength(3);
  });

  it('rejects edges with unknown endpoints', () => {
    const g = new EvidenceGraph();
    g.upsert({ id: 'a', kind: 'service', label: 'a' });
    expect(() => g.link({ from: 'a', to: 'ghost', relation: 'references' })).toThrow();
  });

  it('finds deploys that landed just before the incident', () => {
    const g = demoGraph();
    const t0 = 1_700_000_000_000;
    const hits = g.correlatedDeploys('svc:checkout', t0 + 180_000, 60 * 60_000);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.deploymentId).toBe('deploy:v2.41');
    expect(hits[0]?.leadMs).toBe(180_000);
  });

  it('round-trips through a snapshot', () => {
    const g = EvidenceGraph.fromSnapshot(demoGraph().snapshot());
    expect(g.size()).toBe(5);
    expect(g.edgeCount()).toBe(5);
  });
});

describe('hypothesis engine', () => {
  it('ranks the PR hypothesis above a weak alternative', () => {
    const g = demoGraph();
    const ranked = rankHypotheses(g, [
      { claim: 'PR #481 changed timeout handling', evidence: ['pr:481', 'deploy:v2.41'] },
      { claim: 'payment-service is down', evidence: ['svc:payment'] },
    ]);
    expect(ranked[0]?.claim).toMatch(/PR #481/);
    expect(ranked[0]?.confidence).toBeGreaterThan(ranked[1]?.confidence ?? 1);
    expect(ranked[0]?.rationale).toMatch(/evidence weight/);
  });

  it('discounts hypotheses with contradicting evidence', () => {
    const g = demoGraph();
    g.upsert({ id: 'metric:canary-clean', kind: 'metric', label: 'canary clean' });
    const [plain, discounted] = [
      rankHypotheses(g, [{ claim: 'c', evidence: ['pr:481'] }])[0]!,
      rankHypotheses(g, [{ claim: 'c', evidence: ['pr:481'], contradicts: ['metric:canary-clean'] }])[0]!,
    ];
    expect(discounted.confidence).toBeLessThan(plain.confidence);
  });

  it('ignores contradictions referencing unknown nodes', () => {
    const g = demoGraph();
    const [a, b] = [
      rankHypotheses(g, [{ claim: 'c', evidence: ['pr:481'] }])[0]!,
      rankHypotheses(g, [{ claim: 'c', evidence: ['pr:481'], contradicts: ['ghost'] }])[0]!,
    ];
    expect(b.confidence).toBe(a.confidence);
  });
});

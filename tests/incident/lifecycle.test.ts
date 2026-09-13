import { describe, it, expect } from 'vitest';
import { EvidenceGraph } from '../../src/evidence/graph';
import {
  assessImpact,
  attachHypotheses,
  awaitApproval,
  beginExecution,
  beginInvestigation,
  beginVerification,
  createIncident,
  deserialize,
  escalate,
  proposeFix,
  resolve,
  serialize,
} from '../../src/incident/brain';
import { IncidentMemory } from '../../src/incident/memory';
import { ServiceTopology } from '../../src/topology/blast';

function investigated() {
  const g = new EvidenceGraph();
  g.upsert({ id: 'svc:checkout', kind: 'service', label: 'checkout-service' });
  g.upsert({ id: 'pr:481', kind: 'pr', label: 'PR #481' });
  g.link({ from: 'svc:checkout', to: 'pr:481', relation: 'correlated_with', weight: 0.78 });
  let r = createIncident('INC-1', 1000);
  r = assessImpact(r, { service: 'checkout-service', severity: 'P1', summary: 'checkout 500s' }, 1001);
  r = beginInvestigation(r, 1002);
  r = attachHypotheses(r, g, [{ claim: 'PR #481', evidence: ['pr:481'] }], 1003);
  return r;
}

describe('incident brain lifecycle', () => {
  it('walks alert → impact → investigating → root_cause → proposed → approval → executing → verifying → resolved', () => {
    let r = investigated();
    expect(r.phase).toBe('root_cause');
    r = proposeFix(r, 'rollback checkout-service to v2.40', 1004);
    r = awaitApproval(r, 'appr-1', 1005);
    r = beginExecution(r, 1006);
    r = beginVerification(r, 1007);
    r = resolve(r, 1008);
    expect(r.phase).toBe('resolved');
    expect(r.remediation?.verified).toBe(true);
    expect(r.timeline.length).toBeGreaterThanOrEqual(8);
  });

  it('rejects out-of-order transitions', () => {
    const r = createIncident('INC-x', 1);
    expect(() => proposeFix(r, 'x', 2)).toThrow();
  });

  it('escalates from any phase with a reason', () => {
    const r = escalate(createIncident('INC-e', 1), 'verification failed', 2);
    expect(r.phase).toBe('escalated');
    expect(r.timeline.join(' ')).toMatch(/verification failed/);
  });

  it('survives a durable round-trip (serialize → deserialize → continue)', () => {
    const r = investigated();
    const resumed = deserialize(serialize(r));
    expect(resumed.phase).toBe('root_cause');
    const next = proposeFix(resumed, 'rollback', 2000);
    expect(next.phase).toBe('proposed');
  });
});

describe('incident memory (case-based reasoning)', () => {
  it('recalls the similar past incident with its root cause', () => {
    const mem = new IncidentMemory();
    mem.store({
      id: 'INC-1842', service: 'checkout-service', severity: 'P1',
      symptoms: ['checkout 500', 'payment timeout'], hypothesesAttempted: ['PR #481'],
      failedActions: ['restart checkout pod'], rootCause: 'Redis connection exhaustion',
      remediation: 'raise pool + restart', mttrMs: 42 * 60_000,
    });
    mem.store({
      id: 'INC-1900', service: 'search-service', severity: 'P3',
      symptoms: ['slow autocomplete'], hypothesesAttempted: [], failedActions: [],
    });
    const line = mem.recallLine({
      id: 'INC-new', service: 'checkout-service', severity: 'P1',
      symptoms: ['checkout 500s', 'payment timeouts'], hypothesesAttempted: [], failedActions: [],
    });
    expect(line).toMatch(/INC-1842/);
    expect(line).toMatch(/Redis connection exhaustion/);
  });

  it('stays silent when nothing is similar', () => {
    const mem = new IncidentMemory();
    expect(mem.recallLine({
      id: 'INC-new', service: 'billing', severity: 'P4',
      symptoms: ['weird invoice font'], hypothesesAttempted: [], failedActions: [],
    })).toBeUndefined();
  });
});

describe('blast radius', () => {
  it('computes transitive blast radius and risk-aware approvals', () => {
    const topo = new ServiceTopology();
    topo.upsert('checkout-service', ['payment-service']);
    topo.upsert('storefront', ['checkout-service']);
    topo.upsert('payment-service', []);

    const restart = topo.assess('payment-service', 'restart');
    expect(restart.affected).toContain('checkout-service');
    expect(restart.affected).toContain('storefront');
    expect(restart.risk).toBe('medium');
    expect(restart.approvalsRequired).toBe(1);

    const leaf = topo.assess('lonely', 'restart');
    expect(leaf.risk).toBe('low');
    expect(leaf.approvalsRequired).toBe(0);

    const failover = topo.assess('payment-service', 'failover');
    expect(failover.risk).toBe('critical');
    expect(failover.approvalsRequired).toBe(2);
    expect(failover.requiresMaintenanceWindow).toBe(true);
  });
});

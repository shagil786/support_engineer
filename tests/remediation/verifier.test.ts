import { describe, it, expect } from 'vitest';
import { verifyRemediation, type RemediationPolicy } from '../../src/remediation/verifier';

const policy: RemediationPolicy = {
  service: 'payment-service',
  settleMs: 0,
  criteria: [
    { metric: 'error_rate', op: 'lt', threshold: 0.01, label: 'error rate < 1%' },
    { metric: 'p95_latency_ms', op: 'lt', threshold: 500, label: 'p95 restored' },
  ],
  synthetic: { name: 'synthetic-checkout' },
  onFailure: 'rollback',
  rollbackRunbookId: 'rollback-payment',
};

const metricsAt = (errorRate: number, p95: number) => ({
  name: 'test-metrics',
  query: async (_service: string, kind: string) => ({
    name: kind,
    kind,
    points: [{ ts: 1, value: kind === 'error_rate' ? errorRate : p95 }],
  }),
});

describe('verifyRemediation', () => {
  it('confirms mitigation when every criterion and the synthetic pass', async () => {
    const v = await verifyRemediation(policy, {
      metrics: metricsAt(0.002, 320),
      synthetic: async () => true,
      sleep: async () => {},
    });
    expect(v.passed).toBe(true);
    expect(v.next).toBe('confirmed');
    expect(v.timeline.join('\n')).toMatch(/mitigation confirmed/);
  });

  it('fails closed and names the rollback when a metric misses', async () => {
    const v = await verifyRemediation(policy, {
      metrics: metricsAt(0.08, 320),
      synthetic: async () => true,
      sleep: async () => {},
    });
    expect(v.passed).toBe(false);
    expect(v.next).toBe('rollback-payment');
    expect(v.readings[0]?.passed).toBe(false);
  });

  it('fails closed when metrics are unwired (no data ≠ healthy)', async () => {
    const v = await verifyRemediation(policy, { synthetic: async () => true, sleep: async () => {} });
    expect(v.passed).toBe(false);
    expect(v.timeline.join('\n')).toMatch(/no data/);
  });

  it('escalates when the policy says so', async () => {
    const v = await verifyRemediation({ ...policy, onFailure: 'escalate' }, {
      metrics: metricsAt(0.5, 9000),
      synthetic: async () => false,
      sleep: async () => {},
    });
    expect(v.passed).toBe(false);
    expect(v.next).toBe('escalate');
  });
});

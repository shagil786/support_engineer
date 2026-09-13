import { describe, it, expect } from 'vitest';
import { correlateChanges, type ChangeRecord } from '../../src/change/types';
import { summarizeCrossSignal } from '../../src/signals/types';

const T0 = 1_700_000_000_000;

const changes: ChangeRecord[] = [
  { id: 'pr-481', label: 'PR #481', kind: 'pr', ts: T0, service: 'checkout-service', files: ['src/timeout.ts'], summary: 'changed timeout handling' },
  { id: 'deploy-v241', label: 'deploy v2.41', kind: 'deploy', ts: T0 + 60_000, service: 'checkout-service' },
  { id: 'flag-x', label: 'flag checkout-banner=on', kind: 'flag', ts: T0 - 10_000_000, service: 'checkout-service' },
];

describe('change correlation', () => {
  it('ranks the deploy first and the stale flag never surfaces', () => {
    const suspects = correlateChanges(changes, {
      incidentTs: T0 + 240_000,
      lookbackMs: 60 * 60_000,
      signals: ['timeout', 'checkout'],
      files: ['src/timeout.ts'],
    });
    expect(suspects.map((s) => s.change.id)).toEqual(['pr-481', 'deploy-v241']);
    expect(suspects[0]?.reasons.join(' ')).toMatch(/timeout/);
    expect(suspects[0]?.suspicion).toBeGreaterThan(0.5);
  });

  it('drops changes outside the lookback window', () => {
    const suspects = correlateChanges(changes, { incidentTs: T0 + 240_000, lookbackMs: 5 * 60_000 });
    expect(suspects.map((s) => s.change.id)).not.toContain('flag-x');
  });

  it('is deterministic for the same input', () => {
    const opts = { incidentTs: T0 + 240_000, lookbackMs: 60 * 60_000, signals: ['timeout'] };
    expect(correlateChanges(changes, opts)).toEqual(correlateChanges(changes, opts));
  });
});

describe('cross-signal summary', () => {
  it('reports the dependency entry share without inventing percentages', () => {
    const failed = Array.from({ length: 11 }, (_, i) => ({
      traceId: `t${i}`,
      spans: [
        { spanId: `s${i}a`, traceId: `t${i}`, service: 'checkout-service', operation: 'POST /checkout', durationMs: 2100, ts: T0, status: 'error' as const },
        ...(i < 10
          ? [{ spanId: `s${i}b`, traceId: `t${i}`, service: 'payment-service', operation: 'charge', durationMs: 2000, ts: T0, status: 'error' as const }]
          : []),
      ],
    }));
    const s = summarizeCrossSignal({
      service: 'checkout-service',
      from: T0 - 900_000,
      to: T0,
      errorRate: { name: 'checkout errors', kind: 'error_rate', points: [{ ts: T0, value: 0.18 }] },
      p99: { name: 'checkout p99', kind: 'p99_latency_ms', points: [{ ts: T0, value: 2100 }] },
      failed,
    });
    expect(s.dependencyEntryShare['payment-service']).toBeCloseTo(10 / 11, 5);
    expect(s.waterfallNote).toMatch(/91%/);
    expect(s.waterfallNote).toMatch(/payment-service/);
    expect(s.errorRate).toBeCloseTo(0.18, 5);
  });

  it('handles empty trace samples honestly', () => {
    const s = summarizeCrossSignal({ service: 'svc', from: 0, to: 1, failed: [] });
    expect(s.failedTraceCount).toBe(0);
    expect(s.dependencyEntryShare).toEqual({});
    expect(s.waterfallNote).toMatch(/0 failed/);
  });
});

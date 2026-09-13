/**
 * summarizeCrossSignal — direct unit pins for the investigator's
 * "one paragraph" arithmetic (ADR: no LLM, no invented percentages). The
 * change-correlation and incident suites drive it on happy paths; these pin
 * the entry-span selection rules, share normalization, last-value metric
 * semantics, and the waterfall-note composition contract.
 */
import { describe, it, expect } from 'vitest';
import { summarizeCrossSignal, type MetricSeries, type TraceSample } from '../../src/signals/types';

const T0 = 1_700_000_000_000;

function span(over: Partial<TraceSample['spans'][number]> & { service: string }): TraceSample['spans'][number] {
  return { spanId: 's', traceId: 't', operation: 'op', durationMs: 10, ts: T0, status: 'ok', ...over };
}

function series(points: Array<{ ts: number; value: number }>): MetricSeries {
  return { name: 'svc', kind: 'x', points };
}

describe('summarizeCrossSignal (entry-span selection)', () => {
  it('prefers the FIRST error span on a dependency; the incident service itself is never the entry', () => {
    const failed: TraceSample[] = [
      {
        traceId: 't1',
        spans: [
          span({ service: 'checkout-service', spanId: 'root', status: 'error' }), // own service — skipped
          span({ service: 'dep-b', spanId: 'b1', status: 'ok' }),
          span({ service: 'dep-a', spanId: 'a1', status: 'error' }),
        ],
      },
    ];
    const s = summarizeCrossSignal({ service: 'checkout-service', from: T0, to: T0 + 1, failed });
    expect(s.dependencyEntryShare).toEqual({ 'dep-a': 1 });
    expect(s.waterfallNote).toContain('100% enter dep-a');
  });

  it('falls back to the first dependency span (any status) when no dependency errored', () => {
    const failed: TraceSample[] = [
      {
        traceId: 't2',
        spans: [
          span({ service: 'checkout-service', spanId: 'root' }),
          span({ service: 'dep-b', spanId: 'b1' }),
          span({ service: 'dep-a', spanId: 'a1' }),
        ],
      },
    ];
    const s = summarizeCrossSignal({ service: 'checkout-service', from: T0, to: T0 + 1, failed });
    expect(s.dependencyEntryShare).toEqual({ 'dep-b': 1 });
  });

  it('a trace with no dependency spans contributes nothing to the shares', () => {
    const failed: TraceSample[] = [
      { traceId: 't3', spans: [span({ service: 'checkout-service', spanId: 'root', status: 'error' })] },
      { traceId: 't4', spans: [span({ service: 'dep-a', spanId: 'a1', status: 'error' })] },
    ];
    const s = summarizeCrossSignal({ service: 'checkout-service', from: T0, to: T0 + 1, failed });
    expect(s.failedTraceCount).toBe(2);
    expect(s.dependencyEntryShare).toEqual({ 'dep-a': 0.5 });
  });

  it('shares are per-dependency fractions of all failed traces (2 deps → 0.5/0.5)', () => {
    const failed: TraceSample[] = [
      { traceId: 't1', spans: [span({ service: 'dep-a', spanId: 'a', status: 'error' })] },
      { traceId: 't2', spans: [span({ service: 'dep-b', spanId: 'b', status: 'error' })] },
    ];
    const s = summarizeCrossSignal({ service: 'svc', from: T0, to: T0 + 1, failed });
    expect(s.dependencyEntryShare).toEqual({ 'dep-a': 0.5, 'dep-b': 0.5 });
  });
});

describe('summarizeCrossSignal (metrics semantics)', () => {
  it('uses the LAST point of a series (the freshest window value)', () => {
    const s = summarizeCrossSignal({
      service: 'svc',
      from: T0,
      to: T0 + 1,
      errorRate: series([
        { ts: T0 - 60_000, value: 0.1 },
        { ts: T0, value: 0.2 },
      ]),
      failed: [],
    });
    expect(s.errorRate).toBe(0.2);
  });

  it('an empty series is treated as missing — the key is omitted, not zero', () => {
    const s = summarizeCrossSignal({
      service: 'svc',
      from: T0,
      to: T0 + 1,
      errorRate: series([]),
      p99: series([]),
      failed: [],
    });
    expect('errorRate' in s).toBe(false);
    expect('p99LatencyMs' in s).toBe(false);
    expect(s.waterfallNote).toBe('0 failed trace(s) sampled');
  });

  it('composes the full note in contract order with rounding', () => {
    const failed: TraceSample[] = [
      { traceId: 't1', spans: [span({ service: 'dep-a', spanId: 'a', status: 'error' })] },
      { traceId: 't2', spans: [span({ service: 'dep-a', spanId: 'a2', status: 'error' })] },
      { traceId: 't3', spans: [span({ service: 'dep-b', spanId: 'b', status: 'error' })] },
    ];
    const s = summarizeCrossSignal({
      service: 'svc',
      from: T0 - 900_000,
      to: T0,
      errorRate: series([{ ts: T0, value: 0.18 }]),
      p99: series([{ ts: T0, value: 2099.6 }]),
      failed,
    });
    expect(s.waterfallNote).toBe('error rate 18.0%; p99 2100ms; 3 failed trace(s) sampled; 67% enter dep-a');
    expect(s.p99LatencyMs).toBe(2099.6); // note rounds for prose, the field keeps precision
    expect(s.window).toEqual({ from: T0 - 900_000, to: T0 });
  });
});

import { describe, it, expect } from 'vitest';
import { correlationId } from '../../src/event-log/correlation';

describe('correlationId', () => {
  it('returns a string', () => {
    expect(typeof correlationId()).toBe('string');
  });

  it('is monotonically sortable when called with the same timestamp', () => {
    const ts = 1_700_000_000_000;
    const ids = Array.from({ length: 100 }, () => correlationId(ts));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids); // already sorted
  });

  it('is unique across 10k calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(correlationId());
    expect(ids.size).toBe(10_000);
  });

  it('starts with the hex epoch ms', () => {
    const ts = 1_700_000_000_000;
    expect(correlationId(ts).startsWith(ts.toString(16))).toBe(true);
  });
});

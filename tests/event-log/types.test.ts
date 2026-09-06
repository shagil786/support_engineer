import { describe, it, expect } from 'vitest';
import type { DecisionEvent } from '../../src/event-log/types';
import { isDecisionEvent } from '../../src/event-log/types';

const baseFields = { correlationId: 'abc', ts: 1, layer: 'governance' as const, source: 'internal' as const };

describe('DecisionEvent types', () => {
  it('accepts an understanding event', () => {
    const e: DecisionEvent = {
      ...baseFields,
      kind: 'understanding',
      envelope: { intent: { kind: 'unknown' }, confidence: 0, entities: {}, rawContext: { source: 'meeting', ts: 1, payload: {} } },
      contextBundleRef: 'ctx-1',
    };
    expect(isDecisionEvent(e)).toBe(true);
  });

  it('accepts a tool_call event', () => {
    const e: DecisionEvent = {
      ...baseFields,
      kind: 'tool_call',
      tool: 'query_logs',
      args: { query_string: 'error' },
      result: { ok: true, data: { rows: [] } },
      latencyMs: 120,
      attempts: 1,
    };
    expect(isDecisionEvent(e)).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(isDecisionEvent({ ...baseFields, kind: 'bogus' } as unknown)).toBe(false);
  });
});

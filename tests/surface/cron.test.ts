import { describe, it, expect } from 'vitest';
import { buildCronEnvelope } from '../../src/surface/async/cron';

describe('buildCronEnvelope', () => {
  it('builds an async_triage envelope with the cron source', () => {
    const env = buildCronEnvelope('daily-report', 1234);
    expect(env.intent.kind).toBe('async_triage');
    expect(env.rawContext.source).toBe('cron');
    expect(env.rawContext.ts).toBe(1234);
    expect(env.rawContext.payload).toEqual({ scheduledJob: 'daily-report' });
  });
});

/**
 * Cron surface (spec §3.1, async mode): scheduled jobs (nightly extraction,
 * periodic sweeps) enter the pipeline as async_triage envelopes.
 */
import type { IntentEnvelope } from '../../event-log/types.js';

export function buildCronEnvelope(scheduledJob: string, ts: number = Date.now()): IntentEnvelope {
  return {
    intent: { kind: 'async_triage', subKind: 'fyi' },
    confidence: 1,
    entities: {},
    rawContext: { source: 'cron', ts, payload: { scheduledJob } },
  };
}

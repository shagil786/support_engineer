/**
 * Envelope dispatch (spec §3.1): turns an authenticated delivery from a
 * known surface source into the IntentEnvelope the pipeline consumes.
 *
 * Untrusted-input rule: payloads that fail their parser are DROPPED
 * (undefined), never guessed into an envelope — same contract as the
 * parsers themselves.
 */
import type { IntentEnvelope } from '../event-log/types.js';
import { parseJiraWebhook } from './async/jira-webhook.js';
import { parseSlackMention } from './async/slack-mention.js';
import { buildCronEnvelope } from './async/cron.js';
import { anomalyToEnvelope, type AnomalySignal } from './proactive/anomaly-detector.js';

/** Detect a cron delivery by shape: a named scheduled job. */
function asCronJob(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const job = (body as { scheduledJob?: unknown }).scheduledJob;
  return typeof job === 'string' && job.trim() !== '' ? job : undefined;
}

/** Detect a monitoring signal by shape (tolerates the Severity union only). */
function asAnomalySignal(body: unknown): AnomalySignal | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { severity?: unknown; summary?: unknown; source?: unknown; ts?: unknown };
  if (typeof b.severity !== 'string' || !/^P[0-9]$/.test(b.severity)) return undefined;
  if (typeof b.summary !== 'string' || b.summary === '') return undefined;
  if (b.source !== 'cloudwatch' && b.source !== 'splunk') return undefined;
  if (typeof b.ts !== 'number' || !Number.isFinite(b.ts)) return undefined;
  return { severity: b.severity as AnomalySignal['severity'], summary: b.summary, source: b.source, ts: b.ts };
}

/** Build the envelope for a delivery from a known source. Unknown sources
 *  return undefined (the endpoint 400s); validation failures also return
 *  undefined (the endpoint reports `accepted: false`). */
export function buildEnvelope(source: string, body: unknown): IntentEnvelope | undefined {
  if (source === 'jira') return parseJiraWebhook(body);
  if (source === 'slack-mention') return parseSlackMention(body);
  if (source === 'cron') {
    const job = asCronJob(body);
    return job ? buildCronEnvelope(job) : undefined;
  }
  const signal = asAnomalySignal(body);
  if (source === 'anomaly' && signal) return anomalyToEnvelope(signal);
  return undefined;
}

/** The sources /envelope accepts. Anything else is a client error. */
export const ENVELOPE_SOURCES: readonly string[] = ['jira', 'anomaly', 'slack-mention', 'cron'];

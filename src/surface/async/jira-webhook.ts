/**
 * Jira webhook surface (spec §3.1, async mode). Parses an incoming webhook
 * payload into an IntentEnvelope for the pipeline. Untrusted input: anything
 * that fails validation is dropped (returns undefined), never guessed.
 */
import { z } from 'zod';
import type { IntentEnvelope } from '../../event-log/types.js';

const Schema = z.object({
  webhookEvent: z.string(),
  issue: z
    .object({
      key: z.string().min(1),
      fields: z.object({ summary: z.string().optional() }).partial().optional(),
    })
    .optional(),
});

export function parseJiraWebhook(body: unknown, now: () => number = Date.now): IntentEnvelope | undefined {
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return undefined;
  const { webhookEvent, issue } = parsed.data;
  if (!issue) return undefined;
  return {
    intent: { kind: 'async_triage', subKind: webhookEvent.includes('created') ? 'incident' : 'fyi' },
    confidence: 1,
    entities: { ticketKeys: [issue.key] },
    rawContext: { source: 'jira', ts: now(), payload: body },
  };
}

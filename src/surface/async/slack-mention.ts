/**
 * Slack mention surface (spec §3.1, async mode): an @agent mention in Slack
 * becomes an async triage question with the speaker recorded so RBAC and
 * the ApprovalGate can attribute actions.
 */
import { z } from 'zod';
import type { IntentEnvelope } from '../../event-log/types.js';

const Schema = z.object({
  text: z.string().min(1),
  user: z.string().min(1),
});

export function parseSlackMention(body: unknown, now: () => number = Date.now): IntentEnvelope | undefined {
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return undefined;
  return {
    intent: { kind: 'async_triage', subKind: 'question' },
    confidence: 1,
    entities: { speakerId: parsed.data.user },
    rawContext: { source: 'slack', ts: now(), payload: body },
  };
}

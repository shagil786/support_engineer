/**
 * Deterministic fallback for the IntentClassifier. Used when no LLM is
 * wired or when the LLM envelope fails validation. Delegates to today's
 * heuristics.ts so v1 behavior is byte-for-byte preserved — this file
 * never reimplements a heuristic.
 *
 * Order note: runbook offers are checked before direct questions because
 * "can you restart X?" is both; the offer is the more specific intent.
 */
import type { IntentEnvelope } from '../../event-log/types.js';
import * as h from '../../support-voice-agent/heuristics.js';

export type ClassifySource = 'meeting' | 'jira' | 'slack' | 'cloudwatch' | 'splunk' | 'cron';

export interface ClassifyInput {
  text: string;
  source: ClassifySource;
  ts: number;
  speakerId?: string;
  payload?: unknown;
}

function containsRunbookOffer(text: string): boolean {
  return /\b(can you|please|could you|would you)\b.*\b(restart|reboot|clear|rerun|deploy|roll\s*back|redeploy)\b/i.test(text);
}

function pickIntent(text: string): IntentEnvelope['intent'] {
  if (h.isShutUpCommand(text)) return { kind: 'meeting_response', subKind: 'mute' };
  if (h.isCriticalDeclaration(text)) return { kind: 'meeting_response', subKind: 'critical' };
  if (h.isFeedback(text)) return { kind: 'meeting_response', subKind: 'feedback' };
  if (h.isVagueTechnicalComplaint(text)) return { kind: 'meeting_response', subKind: 'complaint' };
  if (containsRunbookOffer(text)) return { kind: 'meeting_response', subKind: 'runbook_offer' };
  if (h.isDirectQuestion(text)) return { kind: 'meeting_response', subKind: 'question' };
  if (h.containsWakeWord(text)) return { kind: 'meeting_response', subKind: 'wake' };
  return { kind: 'unknown' };
}

export class LegacyClassifierAdapter {
  classify(input: ClassifyInput): IntentEnvelope {
    const text = input.text.trim();
    const intent = pickIntent(text);
    const entities: IntentEnvelope['entities'] = {};
    const severity = h.parsePriority(text);
    if (severity && intent.kind === 'meeting_response' && intent.subKind === 'critical') {
      entities.severity = severity;
    }
    const ticket = h.extractTicketKey(text);
    if (ticket) entities.ticketKeys = [ticket];
    if (input.speakerId) entities.speakerId = input.speakerId;
    return {
      intent,
      confidence: intent.kind === 'unknown' ? 0 : 1,
      entities,
      rawContext: { source: input.source, ts: input.ts, payload: input.payload ?? {} },
    };
  }
}

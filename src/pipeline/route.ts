/**
 * Intent → route policy: the single place that decides whether an input
 * belongs to the legacy etiquette cascade or the governed pipeline.
 *
 * Etiquette intents (mute, wake, critical, complaint, feedback) and
 * unrecognized chatter go straight to the legacy cascade, always — the
 * pipeline does not intercept what works.
 */
import type { IntentEnvelope } from '../event-log/types.js';

const ETIQUETTE_SUBKINDS = new Set(['mute', 'wake', 'critical', 'complaint', 'feedback']);

export type IntentRoute = 'legacy' | 'pipeline';

export function routeIntent(envelope: IntentEnvelope): IntentRoute {
  if (envelope.intent.kind === 'unknown') return 'legacy';
  if (envelope.intent.kind === 'meeting_response' && ETIQUETTE_SUBKINDS.has(envelope.intent.subKind)) return 'legacy';
  return 'pipeline';
}
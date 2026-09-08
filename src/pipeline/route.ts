/**
 * Intent → route policy: the single place that decides where an input goes:
 *   - 'etiquette': talk-permission (mute/wake) — owned by the pipeline's
 *     EtiquetteGate in orchestrated mode (pass one of the two-brain
 *     consolidation); the legacy cascade still serves standalone hosts.
 *   - 'legacy': action etiquette the cascade owns end to end (critical,
 *     complaint, feedback) and unrecognized chatter.
 *   - 'pipeline': governed work — questions, log queries, runbooks.
 */
import type { IntentEnvelope } from '../event-log/types.js';

const ETIQUETTE_SUBKINDS = new Set(['mute', 'wake', 'critical', 'complaint', 'feedback']);
const TALK_PERMISSION_SUBKINDS = new Set(['mute', 'wake']);

export type IntentRoute = 'etiquette' | 'legacy' | 'pipeline';

export function routeIntent(envelope: IntentEnvelope): IntentRoute {
  if (envelope.intent.kind === 'unknown') return 'legacy';
  if (envelope.intent.kind === 'meeting_response' && TALK_PERMISSION_SUBKINDS.has(envelope.intent.subKind)) return 'etiquette';
  if (envelope.intent.kind === 'meeting_response' && ETIQUETTE_SUBKINDS.has(envelope.intent.subKind)) return 'legacy';
  return 'pipeline';
}
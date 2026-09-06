/**
 * Anomaly-detector surface (spec §3.1, proactive mode): monitoring signals
 * become proactive_alert envelopes. P0/P1 are incidents (immediate barge-in
 * candidate); P2+ are anomalies (logged, no interruption).
 */
import type { IntentEnvelope } from '../../event-log/types.js';
import type { Severity } from '../../support-voice-agent/types.js';

export interface AnomalySignal {
  severity: Severity;
  summary: string;
  source: 'cloudwatch' | 'splunk';
  ts: number;
}

export function isIncidentWorthy(severity: Severity): boolean {
  return severity === 'P0' || severity === 'P1';
}

export function anomalyToEnvelope(signal: AnomalySignal): IntentEnvelope {
  return {
    intent: { kind: 'proactive_alert', subKind: isIncidentWorthy(signal.severity) ? 'incident' : 'anomaly' },
    confidence: 1,
    entities: { severity: signal.severity, services: [] },
    rawContext: { source: signal.source, ts: signal.ts, payload: signal },
  };
}

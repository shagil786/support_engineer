import { describe, it, expect } from 'vitest';
import { anomalyToEnvelope, isIncidentWorthy } from '../../src/surface/proactive/anomaly-detector';

describe('anomalyToEnvelope', () => {
  it('builds a proactive_alert incident envelope for P1', () => {
    const env = anomalyToEnvelope({ severity: 'P1', summary: 'error rate spike', source: 'cloudwatch', ts: 1 });
    expect(env.intent).toEqual({ kind: 'proactive_alert', subKind: 'incident' });
    expect(env.entities.severity).toBe('P1');
    expect(env.rawContext.source).toBe('cloudwatch');
  });

  it('builds an anomaly envelope for low-severity signals', () => {
    const env = anomalyToEnvelope({ severity: 'P3', summary: 'cache miss drift', source: 'splunk', ts: 2 });
    expect(env.intent).toEqual({ kind: 'proactive_alert', subKind: 'anomaly' });
  });

  it('classifies incident-worthiness by severity', () => {
    expect(isIncidentWorthy('P0')).toBe(true);
    expect(isIncidentWorthy('P1')).toBe(true);
    expect(isIncidentWorthy('P2')).toBe(false);
    expect(isIncidentWorthy('P4')).toBe(false);
  });
});

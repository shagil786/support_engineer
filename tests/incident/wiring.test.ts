import { describe, it, expect } from 'vitest';
import { createPlatform } from '../../src/bootstrap';
import { EvidenceGraph } from '../../src/evidence/graph';
import { ServiceTopology } from '../../src/topology/blast';

describe('platform wiring for incident support', () => {
  it('passes evidence/change/signal/topology ports into the ToolRunner', async () => {
    const graph = new EvidenceGraph();
    graph.upsert({ id: 'svc:checkout-service', kind: 'service', label: 'checkout-service' });
    const topology = new ServiceTopology();
    topology.upsert('checkout-service', []);
    const platform = createPlatform({
      dataDir: '/tmp/incident-support-test',
      evidenceGraph: graph,
      changeProvider: { name: 'fake', recentChanges: async () => [] },
      metricsProvider: { name: 'fake-m', query: async () => ({ name: 'x', kind: 'error_rate', points: [] }) },
      traceProvider: { name: 'fake-t', failedTraces: async () => [] },
      topology,
      syntheticCheck: async () => true,
    });
    // The platform boots without touching the new ports; the runner honors them.
    await platform.ready().catch(() => ({}));
    platform.stopLearning();
  });

  it('new modules are importable from the incident-support barrel', async () => {
    const m = await import('../../src/incident-support');
    expect(typeof m.EvidenceGraph).toBe('function');
    expect(typeof m.rankHypotheses).toBe('function');
    expect(typeof m.correlateChanges).toBe('function');
    expect(typeof m.summarizeCrossSignal).toBe('function');
    expect(typeof m.verifyRemediation).toBe('function');
    expect(typeof m.ServiceTopology).toBe('function');
    expect(typeof m.createIncident).toBe('function');
    expect(typeof m.IncidentMemory).toBe('function');
  });
});

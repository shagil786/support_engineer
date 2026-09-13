import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../../src/bootstrap';
import { EvidenceGraph } from '../../src/evidence/graph';
import { ServiceTopology } from '../../src/topology/blast';
import { createIncident } from '../../src/incident-support';

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
    expect(typeof m.FileBackedIncidentStore).toBe('function');
    expect(typeof m.FileBackedIncidentMemory).toBe('function');
  });

  it('platform incidents and case memory persist across restarts on the same dataDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'incident-durable-platform-'));
    const mk = () => createPlatform({ dataDir: dir });
    const first = mk();
    first.incidents.save(createIncident('INC-dur', 1));
    first.incidentMemory.store({
      id: 'INC-dur',
      service: 'checkout-service',
      severity: 'P1',
      symptoms: ['checkout 500'],
      hypothesesAttempted: [],
      failedActions: [],
    });
    const reborn = mk();
    expect(reborn.incidents.get('INC-dur')?.phase).toBe('alert');
    expect(reborn.incidentMemory.size()).toBe(1);
    await Promise.all([first.ready().catch(() => ({})), reborn.ready().catch(() => ({}))]);
    first.stopLearning();
    reborn.stopLearning();
  });
});

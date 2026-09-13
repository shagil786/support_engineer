import { describe, it, expect } from 'vitest';
import { ToolRunner } from '../../src/execution/tool-runner';
import { EvidenceGraph } from '../../src/evidence/graph';
import { ServiceTopology } from '../../src/topology/blast';
import type { Decision, GovernedAction } from '../../src/governance/decision';
import type { ToolName } from '../../src/support-voice-agent/tools/types';

const allow: Decision = { effect: 'allow', reason: 'test', policyIds: ['test'] };
const ctx = () => ({
  correlationId: 'c-evidence',
  speakerId: 'u1',
  tokens: { prompt: 0, completion: 0 },
  candidateOutput: '',
  toolCallHistory: [] as Array<{ tool: ToolName; args: unknown }>,
});
const exec = (tool: ToolName, args: Record<string, unknown>): GovernedAction => ({
  kind: 'execute',
  decision: allow,
  action: { tool, args },
});

describe('new execution tools (wired + unwired)', () => {
  it('query_evidence returns the subgraph around a service', async () => {
    const graph = new EvidenceGraph();
    graph.upsert({ id: 'svc:checkout-service', kind: 'service', label: 'checkout-service' });
    graph.upsert({ id: 'deploy:v2.41', kind: 'deployment', label: 'deploy v2.41', ts: 1000 });
    graph.link({ from: 'svc:checkout-service', to: 'deploy:v2.41', relation: 'correlated_with' });
    const runner = new ToolRunner({ context: { evidenceGraph: graph } });
    const r = await runner.run(exec('query_evidence', { service: 'checkout-service' }), ctx());
    expect(r.ok).toBe(true);
    expect(r.ok && (r.data as { nodes: unknown[] }).nodes.length).toBe(2);
  });

  it('new tools degrade honestly when unwired', async () => {
    const runner = new ToolRunner({ context: {} });
    for (const [tool, args] of [
      ['query_evidence', { service: 's' }],
      ['correlate_changes', { service: 's', incident_ts: 10 }],
      ['query_signals', { service: 's', from: 0, to: 10 }],
      ['assess_blast_radius', { service: 's', action: 'restart' }],
    ] as Array<[ToolName, Record<string, unknown>]>) {
      const r = await runner.run(exec(tool, args), ctx());
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(/not configured/);
    }
  });

  it('correlate_changes ranks suspects from the injected provider', async () => {
    const runner = new ToolRunner({
      context: {
        changeProvider: {
          name: 'fake-github',
          recentChanges: async () => [
            { id: 'pr-481', label: 'PR #481', kind: 'pr', ts: 1000, summary: 'timeout handling' },
          ],
        },
      },
    });
    const r = await runner.run(exec('correlate_changes', { service: 'checkout-service', incident_ts: 2000, signals: ['timeout'] }), ctx());
    expect(r.ok).toBe(true);
    expect(r.ok && (r.data as { suspects: Array<{ change: { id: string } }> }).suspects[0]?.change.id).toBe('pr-481');
  });

  it('query_signals summarizes metrics + traces', async () => {
    const runner = new ToolRunner({
      context: {
        metricsProvider: {
          name: 'fake-prom',
          query: async (_s: string, kind: string) => ({ name: kind, kind, service: 's', points: [{ ts: 5, value: kind === 'error_rate' ? 0.02 : 900 }] }),
        },
        traceProvider: { name: 'fake-otel', failedTraces: async () => [] },
      },
    });
    const r = await runner.run(exec('query_signals', { service: 's', from: 0, to: 10 }), ctx());
    expect(r.ok).toBe(true);
    expect(r.ok && (r.data as { waterfallNote: string }).waterfallNote).toMatch(/0 failed/);
  });

  it('verify_remediation confirms when criteria pass, fails closed otherwise', async () => {
    const good = new ToolRunner({
      context: {
        metricsProvider: {
          name: 'fake-prom',
          query: async (_s: string, kind: string) => ({ name: kind, kind, points: [{ ts: 5, value: 0.001 }] }),
        },
        syntheticCheck: async () => true,
      },
    });
    const criteria = [{ metric: 'error_rate', op: 'lt', threshold: 0.01, label: 'error rate < 1%' }];
    const ok = await good.run(exec('verify_remediation', { service: 's', criteria, synthetic: 'synthetic-checkout' }), ctx());
    expect(ok.ok).toBe(true);

    const bad = new ToolRunner({ context: {} });
    const fail = await bad.run(exec('verify_remediation', { service: 's', criteria }), ctx());
    expect(fail.ok).toBe(false);
    expect(fail.ok === false && fail.error).toMatch(/not verified/);
  });

  it('assess_blast_radius reports risk-aware approvals', async () => {
    const topo = new ServiceTopology();
    topo.upsert('payment-service', []);
    topo.upsert('checkout-service', ['payment-service']);
    const runner = new ToolRunner({ context: { topology: topo } });
    const r = await runner.run(exec('assess_blast_radius', { service: 'payment-service', action: 'restart' }), ctx());
    expect(r.ok).toBe(true);
    expect(r.ok && (r.data as { risk: string }).risk).toBe('medium');
  });
});

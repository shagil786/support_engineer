/**
 * Autonomous Production Support Engineer demo (offline, no network).
 * Deploy buggy code -> anomaly -> evidence graph -> change-intel ->
 * hypothesis -> approval -> rollback -> verified remediation -> learning.
 */
import { EvidenceGraph } from '../src/evidence/graph.js';
import { correlateChanges, type ChangeRecord } from '../src/change/types.js';
import { summarizeCrossSignal } from '../src/signals/types.js';
import { verifyRemediation } from '../src/remediation/verifier.js';
import { ServiceTopology } from '../src/topology/blast.js';
import { assessImpact, attachHypotheses, awaitApproval, beginExecution, beginInvestigation, beginVerification, createIncident, proposeFix, resolve } from '../src/incident/brain.js';
import { IncidentMemory } from '../src/incident/memory.js';

export async function runIncidentDemo(): Promise<void> {
  const T0 = Date.now();
  console.log('DEPLOY v2.41 (PR #481: changed timeout handling) -> synthetic traffic starts failing');
  let incident = createIncident('INC-demo-1', T0);
  console.log('ALERT anomaly detector: checkout-service error rate spiking (P1)');
  incident = assessImpact(incident, { service: 'checkout-service', severity: 'P1', summary: 'checkout 500s at 18% error rate' }, T0 + 1000);
  const graph = new EvidenceGraph();
  graph.upsert({ id: 'svc:checkout-service', kind: 'service', label: 'checkout-service' });
  graph.upsert({ id: 'svc:payment-service', kind: 'dependency', label: 'payment-service' });
  graph.upsert({ id: 'deploy:v2.41', kind: 'deployment', label: 'deploy v2.41', ts: T0 - 180000, source: 'cicd' });
  graph.upsert({ id: 'pr:481', kind: 'pr', label: 'PR #481', ts: T0 - 200000, source: 'github' });
  graph.link({ from: 'svc:checkout-service', to: 'svc:payment-service', relation: 'depends_on' });
  graph.link({ from: 'svc:checkout-service', to: 'deploy:v2.41', relation: 'correlated_with' });
  graph.link({ from: 'deploy:v2.41', to: 'pr:481', relation: 'references' });
  graph.link({ from: 'svc:checkout-service', to: 'svc:payment-service', relation: 'exhibits', weight: 0.91 });
  graph.link({ from: 'pr:481', to: 'deploy:v2.41', relation: 'caused_by', weight: 0.78 });
  const deploys = graph.correlatedDeploys('svc:checkout-service', T0, 3600000);
  console.log('EVIDENCE errors started ' + Math.round((deploys[0]?.leadMs ?? 0) / 60000) + 'm after ' + (deploys[0]?.label ?? '?'));
  const changes: ChangeRecord[] = [
    { id: 'pr-481', label: 'PR #481', kind: 'pr', ts: T0 - 200000, service: 'checkout-service', files: ['src/timeout.ts'], summary: 'changed timeout handling' },
    { id: 'deploy-v241', label: 'deploy v2.41', kind: 'deploy', ts: T0 - 180000, service: 'checkout-service' },
  ];
  const suspects = correlateChanges(changes, { incidentTs: T0, lookbackMs: 3600000, signals: ['timeout', 'checkout'], files: ['src/timeout.ts'] });
  const suspect = suspects[0];
  console.log('CHANGE likely cause ' + (suspect?.change.label ?? '?') + ' - ' + Math.round((suspect?.suspicion ?? 0) * 100) + '% suspicion');
  const signals = summarizeCrossSignal({
    service: 'checkout-service', from: T0 - 900000, to: T0,
    errorRate: { name: 'e', kind: 'error_rate', points: [{ ts: T0, value: 0.18 }] },
    p99: { name: 'p', kind: 'p99_latency_ms', points: [{ ts: T0, value: 2100 }] },
    failed: Array.from({ length: 11 }, (_, i) => ({
      traceId: 't' + i,
      spans: [
        { spanId: 'a' + i, traceId: 't' + i, service: 'checkout-service', operation: 'POST /checkout', durationMs: 2100, ts: T0, status: 'error' as const },
        ...(i < 10 ? [{ spanId: 'b' + i, traceId: 't' + i, service: 'payment-service', operation: 'charge', durationMs: 2000, ts: T0, status: 'error' as const }] : []),
      ],
    })),
  });
  console.log('SIGNALS ' + signals.waterfallNote);
  incident = beginInvestigation(incident, T0 + 2000);
  incident = attachHypotheses(incident, graph, [{ claim: 'PR #481 changed timeout handling', evidence: ['pr:481', 'deploy:v2.41'], prior: suspect?.suspicion }], T0 + 3000);
  console.log('BRAIN ' + (incident.timeline[incident.timeline.length - 1] ?? ''));
  const topology = new ServiceTopology();
  topology.upsert('checkout-service', ['payment-service']);
  const blast = topology.assess('checkout-service', 'rollback');
  console.log('BLAST ' + blast.reason + ' -> risk=' + blast.risk + ' (' + blast.approvalsRequired + ' approvals)');
  incident = proposeFix(incident, 'rollback checkout-service to v2.40', T0 + 4000);
  incident = awaitApproval(incident, 'appr-demo-1', T0 + 5000);
  console.log('APPROVAL granted -> executing rollback');
  incident = beginExecution(incident, T0 + 6000);
  incident = beginVerification(incident, T0 + 7000);
  const verdict = await verifyRemediation({
    service: 'checkout-service', settleMs: 0,
    criteria: [
      { metric: 'error_rate', op: 'lt', threshold: 0.01, label: 'error rate < 1%' },
      { metric: 'p95_latency_ms', op: 'lt', threshold: 500, label: 'p95 restored' },
    ],
    synthetic: { name: 'synthetic-checkout' }, onFailure: 'rollback', rollbackRunbookId: 'rollback-checkout',
  }, {
    metrics: { name: 'demo-metrics', query: async (_s: string, kind: string) => ({ name: kind, kind, points: [{ ts: T0, value: kind === 'error_rate' ? 0.002 : 320 }] }) },
    synthetic: async () => true,
    sleep: async () => {},
  });
  for (const line of verdict.timeline) console.log('  . ' + line);
  if (verdict.passed) incident = resolve(incident, T0 + 8000);
  const memory = new IncidentMemory();
  memory.store({ id: incident.id, service: 'checkout-service', severity: 'P1', symptoms: ['checkout 500', 'payment timeout'], hypothesesAttempted: ['PR #481 changed timeout handling'], failedActions: [], rootCause: 'PR #481 changed timeout handling', remediation: 'rollback checkout-service to v2.40', mttrMs: 8000 });
  console.log('LEARN Jira updated, Slack notified, timeline stored as operational memory (phase=' + incident.phase + ')');
  console.log('RECALL ' + memory.recallLine({ id: 'INC-next', service: 'checkout-service', severity: 'P1', symptoms: ['checkout 500s'], hypothesesAttempted: [], failedActions: [] }));
}

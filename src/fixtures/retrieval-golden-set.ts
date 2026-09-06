/**
 * Retrieval golden set — the shipped seed corpus and the queries it must
 * answer. `RETRIEVAL_SEED_DOCS` doubles as demo content for the KB; the
 * eval test ingests exactly this corpus and asserts perfect retrieval, so
 * any regression in chunking, fusion, or re-rank fails the suite loudly.
 */
import type { IngestDoc } from '../understanding/knowledge/chunker.js';
import type { GoldenSet } from '../understanding/knowledge/retrieval-eval.js';

export const RETRIEVAL_SEED_DOCS: IngestDoc[] = [
  {
    id: 'run-restart',
    text: [
      '# Restart the checkout pod',
      'Use this runbook when the checkout service stops responding.',
      '',
      '## Step 1 — check saturation',
      'Check the payments dashboard. If CPU is above 90%, scale the deployment before restarting.',
      '',
      '## Step 2 — rolling restart',
      'Run restart-all only for a full outage; prefer the single-pod restart path.',
    ].join('\n'),
    metadata: { source: 'runbooks', tags: ['checkout', 'restart'] },
  },
  {
    id: 'run-db-failover',
    text: [
      '# Database failover',
      'When the primary database is unreachable, promote the replica.',
      '',
      '## Verify lag',
      'Check replication lag is zero before promoting the replica database.',
    ].join('\n'),
    metadata: { source: 'runbooks', tags: ['database', 'failover'] },
  },
  {
    id: 'inc-42',
    text: 'Postmortem: the checkout timeout incident was caused by connection pool exhaustion in the payments service. Mitigation was a deploy rollback.',
    metadata: { source: 'incidents', date: '2026-08-01', tags: ['payments', 'checkout'] },
  },
  {
    id: 'inc-17',
    text: 'Postmortem: the API gateway returned 503s during the config push. Fix was pinning the retry budget in the load balancer.',
    metadata: { source: 'incidents', date: '2026-06-15', tags: ['api'] },
  },
  {
    id: 'faq-oncall',
    text: 'On-call handbook: pages route through PagerDuty. Acknowledge within five minutes; escalate to the secondary after fifteen.',
    metadata: { source: 'handbook', tags: ['oncall'] },
  },
];

export const RETRIEVAL_GOLDEN_SET: GoldenSet = {
  name: 'shipped-knowledge-golden-set',
  cases: [
    { id: 'g1', query: 'how do I restart the checkout pod', relevantDocIds: ['run-restart'] },
    { id: 'g2', query: 'database replica promotion procedure', relevantDocIds: ['run-db-failover'] },
    { id: 'g3', query: 'what caused the checkout timeout incident', relevantDocIds: ['inc-42'] },
    { id: 'g4', query: 'postmortem pool exhaustion', relevantDocIds: ['inc-42'] },
    { id: 'g5', query: 'who gets paged when oncall escalation fires', relevantDocIds: ['faq-oncall'] },
    { id: 'g6', query: '503 gateway config push retry budget', relevantDocIds: ['inc-17'] },
    { id: 'g7', query: 'unresponsive checkout service reboot', relevantDocIds: ['run-restart'] },
    { id: 'g8', query: 'promote database replica when primary down', relevantDocIds: ['run-db-failover'] },
    {
      id: 'g9',
      query: 'payments',
      relevantDocIds: ['inc-42'],
      where: { source: 'incidents' },
    },
  ],
};

# ADR 0007: Evidence Graph + Change-Intel + Verified Remediation

Date: 2026-09-13
Status: accepted

## Context
The platform was a multi-agent execution layer (triage -> investigator ->
reviewer -> executor) with governed Jira/log/runbook/Slack tools, KB-first
RAG, and a learning loop. Investigations dumped log text into the LLM and
reported "command succeeded" as remediation.

## Decision
Add three capabilities as deterministic, provider-injected libraries (no new
network code in src/):

1. **Evidence Graph** (`src/evidence/`): live incident graph
   service -> dependency -> logs -> traces -> metrics -> deployment -> PR ->
   Jira -> previous incident -> runbook. Hypotheses cite node ids with
   supporting/contradicting evidence and LLM-free confidence
   (`src/evidence/hypotheses.ts`).
2. **Change Intelligence + signals** (`src/change/`, `src/signals/`):
   `ChangeProvider` (GitHub/CI-CD), `MetricsProvider`/`TraceProvider`
   (OTel/Prometheus/Grafana/Datadog/New Relic adapters satisfy the ports),
   deterministic `correlateChanges` and `summarizeCrossSignal`.
3. **Verified remediation** (`src/remediation/`): post-action success
   criteria (metrics + synthetic), fail-closed (no data = FAIL), with
   rollback/escalate next-step. Plus `src/incident/brain.ts` (durable
   lifecycle shape), `src/incident/memory.ts` (case-based reasoning), and
   `src/topology/blast.ts` (risk-aware approvals).

New execution tools (all governed, read-only except verification reads):
`query_evidence`, `correlate_changes`, `query_signals`, `assess_blast_radius`,
`verify_remediation`. Investigator plans the first four; Executor plans
blast assessment before risky actions and verification after every runbook.

## Consequences
- Investigator confidence is auditable (edge weights x priors, contradiction
  discounts), never invented.
- Rollback/production deploy stays behind the existing ApprovalGate;
  blast risk only informs approvalsRequired (low=0, medium=1, critical=2+window).
- Hosts inject providers via `createPlatform({ evidenceGraph, changeProvider,
  metricsProvider, traceProvider, topology, syntheticCheck })`; unwired =
  honest "not configured", never invented PRs/metrics.
- Demo: `npm run demo -- --incident` exercises the full loop offline.

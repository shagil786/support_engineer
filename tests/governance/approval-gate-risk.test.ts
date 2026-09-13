/**
 * Risk-aware approvals (ADR-0007, enforced): the blast tiers computed by
 * ServiceTopology now GATE execution instead of staying advisory.
 *
 *  - `requiredSignatures` — the per-approval M-of-N floor: max(gate default,
 *    policy approver_count, blast tier). Blast can escalate, never
 *    de-escalate below what policy demanded.
 *  - `assertExecutable` — critical-risk actions additionally require an open
 *    maintenance window AT EXECUTION TIME (fail-closed: no window wired →
 *    refuse; throwing window port → refuse).
 */
import { describe, it, expect } from 'vitest';
import { ApprovalGate, requiredSignatures } from '../../src/governance/approval-gate';
import { CLOSED_MAINTENANCE_WINDOW, MaintenanceWindowError } from '../../src/governance/maintenance-window';
import { ServiceTopology, inferBlastAssessment } from '../../src/topology/blast';
import type { SlackLike } from '../../src/governance/approval-gate';
import type { Decision, GovernanceDecision, ProposedAction } from '../../src/governance/decision';

const silentSlack: SlackLike = { async postMessage() {} };

const decision = (effect: Decision['effect'], extra: Partial<GovernanceDecision> = {}): Decision => ({
  effect,
  reason: 'because',
  policyIds: ['p1'],
  ...extra,
});

const RUNBOOK: ProposedAction = { tool: 'execute_runbook_script', args: { script_name: 'restart-checkout-service' } };

const gateWith = (over: Partial<ConstructorParameters<typeof ApprovalGate>[0]> = {}) =>
  new ApprovalGate({
    slack: silentSlack,
    securityChannel: '#sec',
    approverCount: 2,
    ...over,
  });

describe('requiredSignatures (per-approval M-of-N floor)', () => {
  it('keeps the gate default when nothing else applies', () => {
    expect(requiredSignatures(undefined, undefined, 2)).toBe(2);
  });

  it('honors a stricter policy count', () => {
    expect(requiredSignatures(3, undefined, 2)).toBe(3);
  });

  it('escalates to the blast tier when it exceeds policy and default', () => {
    const topo = new ServiceTopology();
    topo.upsert('edge', ['a', 'b', 'c', 'd', 'e']); // 5+ affected → critical
    const critical = topo.assess('edge', 'restart');
    expect(critical.risk).toBe('critical');
    expect(requiredSignatures(1, critical, 1)).toBe(2);
  });

  it('never lets blast de-escalate below the policy count', () => {
    const topo = new ServiceTopology();
    topo.upsert('leaf', []);
    const low = topo.assess('leaf', 'restart');
    expect(low.risk).toBe('low');
    expect(requiredSignatures(3, low, 2)).toBe(3);
  });
});

describe('ApprovalGate blast-tier enforcement', () => {
  it('medium risk: counts signatures against the per-approval floor', async () => {
    const gate = gateWith({ approverCount: 2 });
    const topo = new ServiceTopology();
    topo.upsert('checkout', ['payments']);
    const blast = topo.assess('checkout', 'restart'); // 1 dependent → medium
    expect(blast.risk).toBe('medium');
    const { approvalId } = await gate.request({ policyId: 'p1', decision: decision('require_approval'), action: RUNBOOK, blastAssessment: blast });
    expect(gate.sign(approvalId, 'admin', 'a1').status).toBe('pending'); // 1 of 2
    expect(gate.sign(approvalId, 'admin', 'a2').status).toBe('granted');
  });

  it('critical risk: one signature is blocked; a second grants; the queue reports the raised floor', async () => {
    const gate = gateWith({ approverCount: 1 });
    const topo = new ServiceTopology();
    topo.upsert('db-primary', []);
    const blast = topo.assess('db-primary', 'failover'); // failover → critical
    expect(blast.risk).toBe('critical');
    const { approvalId } = await gate.request({ policyId: 'p1', decision: decision('require_approval'), action: RUNBOOK, blastAssessment: blast });
    expect(gate.sign(approvalId, 'admin', 'a1').status).toBe('pending'); // 1 of 2 — critical floor
    const listing = gate.listPending().find((a) => a.approvalId === approvalId);
    expect(listing?.required).toBe(2);
    expect(gate.sign(approvalId, 'admin', 'a2').status).toBe('granted');
  });

  it('policy can demand more than blast: 3 required even for low risk', async () => {
    const gate = gateWith({ approverCount: 1 });
    const topo = new ServiceTopology();
    topo.upsert('leaf', []);
    const low = topo.assess('leaf', 'restart');
    const { approvalId } = await gate.request({
      policyId: 'p1',
      decision: decision('require_approval', { approverCount: 3 }),
      action: RUNBOOK,
      blastAssessment: low,
    });
    expect(gate.sign(approvalId, 'admin', 'a1').status).toBe('pending');
    expect(gate.sign(approvalId, 'admin', 'a2').status).toBe('pending');
    expect(gate.sign(approvalId, 'admin', 'a3').status).toBe('granted');
  });

  it('audits the raised approver_count and the blast tier on approval_request', async () => {
    const events: Array<Record<string, unknown>> = [];
    const gate = gateWith({ approverCount: 1, eventLog: { append: async (e: Record<string, unknown>) => void events.push(e) } as never });
    const topo = new ServiceTopology();
    topo.upsert('db-primary', []);
    const blast = topo.assess('db-primary', 'failover');
    await gate.request({ policyId: 'p1', decision: decision('require_approval'), action: RUNBOOK, blastAssessment: blast });
    const req = events.find((e) => e.kind === 'approval_request');
    expect(req?.approver_count).toBe(2);
    expect(req?.blastRisk).toBe('critical');
  });
});

describe('assertExecutable — critical risk needs an open maintenance window', () => {
  it('refuses when no window is wired (fail-closed), even with a grant', async () => {
    const gate = gateWith({ approverCount: 1 });
    const topo = new ServiceTopology();
    topo.upsert('db-primary', []);
    const blast = topo.assess('db-primary', 'failover');
    const { approvalId } = await gate.request({ policyId: 'p1', decision: decision('require_approval'), action: RUNBOOK, blastAssessment: blast });
    gate.sign(approvalId, 'admin', 'a1');
    gate.sign(approvalId, 'admin', 'a2');
    expect(gate.status(approvalId)?.status).toBe('granted');
    expect(() => gate.assertExecutable(approvalId)).toThrow(MaintenanceWindowError);
  });

  it('refuses while the window is closed and passes while open', async () => {
    let open = false;
    const gate = gateWith({ approverCount: 1, maintenanceWindow: { isOpen: () => open } });
    const topo = new ServiceTopology();
    topo.upsert('db-primary', []);
    const blast = topo.assess('db-primary', 'failover');
    const { approvalId } = await gate.request({ policyId: 'p1', decision: decision('require_approval'), action: RUNBOOK, blastAssessment: blast });
    gate.sign(approvalId, 'admin', 'a1');
    gate.sign(approvalId, 'admin', 'a2');
    expect(() => gate.assertExecutable(approvalId)).toThrow(MaintenanceWindowError);
    open = true;
    expect(gate.assertExecutable(approvalId).status).toBe('granted');
  });

  it('a closed window never blocks low/medium-risk or unassessed approvals', async () => {
    const gate = gateWith({ approverCount: 1, maintenanceWindow: CLOSED_MAINTENANCE_WINDOW });
    const { approvalId } = await gate.request({ policyId: 'p1', decision: decision('require_approval'), action: RUNBOOK });
    gate.sign(approvalId, 'admin', 'a1');
    expect(gate.assertExecutable(approvalId).status).toBe('granted');
  });
});

describe('inferBlastAssessment — deterministic (tool, args) → assessment', () => {
  const topo = new ServiceTopology();
  topo.upsert('checkout-service', ['payment-service']);
  topo.upsert('payment-service', []);
  topo.upsert('leaf-service', []);

  it('parses verb + service out of the runbook id', () => {
    const r = inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: 'restart-checkout-service' } }, topo);
    expect(r.determined).toBe(true);
    expect(r.assessment?.risk).toBe('medium');
    expect(r.assessment?.approvalsRequired).toBe(1);
  });

  it('prefers explicit service/action args over the id', () => {
    const r = inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: 'restart-checkout-service', service: 'leaf-service', action: 'failover' } }, topo);
    expect(r.assessment?.service).toBe('leaf-service');
    expect(r.assessment?.risk).toBe('critical');
  });

  it('is not determined for unknown services, verbless ids, or read-only tools', () => {
    expect(inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: 'restart-unknown-svc' } }, topo).determined).toBe(false);
    expect(inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: 'clear-cache' } }, topo).determined).toBe(false);
    expect(inferBlastAssessment({ tool: 'query_logs', args: { query_string: 'x' } }, topo).determined).toBe(false);
  });
});

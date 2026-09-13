/**
 * ServiceTopology + inferBlastAssessment — direct unit pins. The governance
 * and execution suites drive these through the approval gate; these pin the
 * graph math and the risk-tier boundaries themselves, including cycle
 * safety and the inference contract that an unresolvable pair is NEVER
 * reported as low risk.
 */
import { describe, it, expect } from 'vitest';
import { ServiceTopology, inferBlastAssessment } from '../../src/topology/blast';

function makeTopology(): ServiceTopology {
  const topo = new ServiceTopology();
  topo.upsert('edge', ['checkout']);
  topo.upsert('checkout', ['payments', 'search']);
  topo.upsert('payments', ['db-primary']);
  return topo;
}

describe('ServiceTopology (graph)', () => {
  it('upsert auto-registers dependency nodes so the graph is queryable both ways', () => {
    const topo = new ServiceTopology();
    topo.upsert('a', ['b']);
    expect(topo.knowsService('b')).toBe(true); // created as an empty node
    expect(topo.knowsService('never-mentioned')).toBe(false);
    expect(topo.dependencies('never-mentioned')).toEqual([]);
  });

  it('dependents are transitive, not just direct', () => {
    const topo = makeTopology();
    // edge → checkout → payments → db-primary
    expect(topo.dependents('db-primary').sort()).toEqual(['checkout', 'edge', 'payments']);
    expect(topo.dependents('checkout')).toEqual(['edge']);
  });

  it('dependency cycles terminate and never list the service as its own dependent', () => {
    const topo = new ServiceTopology();
    topo.upsert('a', ['b']);
    topo.upsert('b', ['a']); // cycle
    topo.upsert('c', ['a']);
    const dependentsOfA = topo.dependents('a').sort();
    expect(dependentsOfA).toEqual(['b', 'c']);
    expect(dependentsOfA).not.toContain('a');
  });

  it('assess unions direct dependencies and transitive dependents, deduped, excluding the service itself', () => {
    const topo = makeTopology();
    const a = topo.assess('checkout', 'restart');
    // direct deps of checkout (payments, search) + transitive dependents (edge).
    // db-primary is a transitive DEPENDENCY, not an affected service.
    expect(a.affected.sort()).toEqual(['edge', 'payments', 'search']);
  });
});

describe('ServiceTopology (risk tiers)', () => {
  it('restart of an isolated leaf is low: no approvals, no window', () => {
    const topo = new ServiceTopology();
    topo.upsert('leaf', []);
    const a = topo.assess('leaf', 'restart');
    expect(a.risk).toBe('low');
    expect(a.approvalsRequired).toBe(0);
    expect(a.requiresMaintenanceWindow).toBe(false);
    expect(a.reason).toContain('no dependents affected');
  });

  it('restart with a small blast radius is medium', () => {
    const topo = makeTopology();
    const a = topo.assess('payments', 'restart'); // db-primary + checkout + edge? No — dependents of payments: checkout, edge
    expect(a.risk).toBe('medium');
    expect(a.approvalsRequired).toBe(1);
    expect(a.reason).toMatch(/3 service\(s\) in blast radius/);
  });

  it('rollback escalates regardless of blast radius — it is stateful by nature', () => {
    const topo = new ServiceTopology();
    topo.upsert('leaf', []);
    expect(topo.assess('leaf', 'rollback').risk).toBe('medium');
  });

  it('rollback (or any action) with 5+ affected services is critical', () => {
    const topo = new ServiceTopology();
    topo.upsert('hub', ['d1', 'd2', 'd3', 'd4', 'd5']);
    const a = topo.assess('hub', 'rollback');
    expect(a.risk).toBe('critical');
    expect(a.approvalsRequired).toBe(2);
    expect(a.requiresMaintenanceWindow).toBe(true);
  });

  it('failover is always critical — even on an isolated leaf', () => {
    const topo = new ServiceTopology();
    topo.upsert('leaf', []);
    const a = topo.assess('leaf', 'failover');
    expect(a.risk).toBe('critical');
    expect(a.approvalsRequired).toBe(2);
    expect(a.requiresMaintenanceWindow).toBe(true);
  });

  it('scale of an isolated service stays low (no state change implied)', () => {
    const topo = new ServiceTopology();
    topo.upsert('leaf', []);
    expect(topo.assess('leaf', 'scale').risk).toBe('low');
  });
});

describe('inferBlastAssessment (deterministic inference)', () => {
  it('never assesses a tool outside the blast-capable set', () => {
    const topo = makeTopology();
    expect(inferBlastAssessment({ tool: 'jira_create_issue', args: { service: 'checkout', action: 'restart' } }, topo)).toEqual({
      determined: false,
    });
  });

  it('no resolvable (service, action) pair → not determined, not assessed', () => {
    const topo = makeTopology();
    expect(inferBlastAssessment({ tool: 'execute_runbook_script', args: {} }, topo).determined).toBe(false);
    // a service with no action verb is still unresolvable
    expect(inferBlastAssessment({ tool: 'execute_runbook_script', args: { service: 'checkout' } }, topo).determined).toBe(false);
    // a verb with no service too
    expect(inferBlastAssessment({ tool: 'execute_runbook_script', args: { action: 'restart' } }, topo).determined).toBe(false);
  });

  it('a resolvable pair on an UNKNOWN service is determined:false — never silently low risk', () => {
    const topo = makeTopology();
    const r = inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: 'failover-mystery-db' } }, topo);
    expect(r.determined).toBe(false);
    expect(r.action).toBe('failover');
    expect(r.service).toBe('mystery-db');
    expect(r.assessment).toBeUndefined();
  });

  it('extracts verb + service from the runbook id, case-insensitively, across separators', () => {
    const topo = makeTopology();
    const cases: Array<[string, string, string]> = [
      ['restart-checkout', 'restart', 'checkout'],
      ['FAILOVER_payments', 'failover', 'payments'],
      ['scale db-primary', 'scale', 'db-primary'],
    ];
    for (const [script, action, service] of cases) {
      const r = inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: script } }, topo);
      expect(r.action).toBe(action);
      expect(r.service).toBe(service);
    }
  });

  it('a verb glued to the service without a separator is not a parseable id', () => {
    const topo = makeTopology();
    expect(inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: 'restart-checkout' } }, topo).determined).toBe(true);
    expect(inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: 'restartcheckout' } }, topo).determined).toBe(false);
    expect(inferBlastAssessment({ tool: 'execute_runbook_script', args: { script_name: 'rollback.search' } }, topo).determined).toBe(false);
  });

  it('explicit args beat the script name; known services get the authoritative assessment', () => {
    const topo = makeTopology();
    const r = inferBlastAssessment(
      { tool: 'execute_runbook_script', args: { script_name: 'restart-checkout', service: 'payments', action: 'rollback' } },
      topo,
    );
    expect(r.determined).toBe(true);
    expect(r.action).toBe('rollback'); // explicit arg wins
    expect(r.service).toBe('payments');
    expect(r.assessment?.risk).toBe('medium');
  });

  it('non-string arg values are ignored, not coerced', () => {
    const topo = makeTopology();
    expect(inferBlastAssessment({ tool: 'restart', args: { action: 42, service: ['checkout'] } }, topo).determined).toBe(false);
  });
});

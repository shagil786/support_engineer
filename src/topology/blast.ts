/**
 * Service Topology + Blast-Radius engine.
 *
 * Maintains a dynamic service dependency graph (from traces / Kubernetes /
 * service metadata) and answers the pre-execution question: "if I restart /
 * rollback / scale / failover THIS, what can be affected?" Risk-aware
 * approvals follow: low → automatic, medium → one approval, critical → two
 * approvals + maintenance window.
 */
export type BlastAction = 'restart' | 'rollback' | 'scale' | 'failover';

export type RiskTier = 'low' | 'medium' | 'critical';

export interface BlastAssessment {
  service: string;
  action: BlastAction;
  /** Transitive dependents + dependencies (excluding the service itself). */
  affected: string[];
  risk: RiskTier;
  approvalsRequired: number;
  requiresMaintenanceWindow: boolean;
  reason: string;
}

export class ServiceTopology {
  /** service → direct dependencies. */
  private readonly deps = new Map<string, Set<string>>();

  upsert(service: string, dependencies: string[]): void {
    this.deps.set(service, new Set(dependencies));
    for (const d of dependencies) {
      if (!this.deps.has(d)) this.deps.set(d, new Set());
    }
  }

  dependencies(service: string): string[] {
    return [...(this.deps.get(service) ?? [])];
  }

  /** Services that directly or transitively depend on `service`. */
  dependents(service: string): string[] {
    const out = new Set<string>();
    const visit = (target: string): void => {
      for (const [svc, ds] of this.deps) {
        if (ds.has(target) && !out.has(svc)) {
          out.add(svc);
          visit(svc);
        }
      }
    };
    visit(service);
    out.delete(service);
    return [...out];
  }

  assess(service: string, action: BlastAction): BlastAssessment {
    const affected = [...new Set([...this.dependencies(service), ...this.dependents(service)])];
    // Risk: restarting a leaf is low; stateful actions (failover) or wide
    // blast radius escalate. Thresholds are deliberately small and explicit.
    let risk: RiskTier = 'low';
    if (action === 'failover') risk = 'critical';
    else if (action === 'rollback' || affected.length >= 3) risk = affected.length >= 5 ? 'critical' : 'medium';
    else if (affected.length >= 1 || action === 'restart') risk = affected.length === 0 ? 'low' : 'medium';
    const approvalsRequired = risk === 'low' ? 0 : risk === 'medium' ? 1 : 2;
    const requiresMaintenanceWindow = risk === 'critical';
    const reason =
      risk === 'low'
        ? `${action} ${service}: no dependents affected`
        : `${action} ${service}: ${affected.length} service(s) in blast radius (${affected.join(', ') || 'none'})`;
    return { service, action, affected, risk, approvalsRequired, requiresMaintenanceWindow, reason };
  }
}

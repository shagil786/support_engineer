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

  /** True when the graph has an entry for `service` (it was upserted, even
   *  with zero dependencies). Unknown services never produce an assessment —
   *  gating on invented topology would be worse than no gating. */
  knowsService(service: string): boolean {
    return this.deps.has(service);
  }
}

/** Tools whose args can carry an infrastructure mutation the topology can
 *  assess. Only real ToolNames plus the canonical action verbs — an unknown
 *  tool is never blast-assessed. */
const BLAST_CAPABLE_TOOLS: ReadonlySet<string> = new Set(['execute_runbook_script', 'restart', 'rollback', 'scale', 'failover']);

/** What inferBlastAssessment concluded. `determined: false` means the tool
 *  args carried no resolvable (service, action) pair — callers must treat
 *  that as "no assessment", never as "low risk". */
export interface BlastInference {
  /** The concrete blast action, when one was inferable. */
  action?: BlastAction;
  /** The target service, when one was inferable. */
  service?: string;
  /** The authoritative assessment, only when the topology knows the service. */
  assessment?: BlastAssessment;
  /** True iff a (service, action) pair was resolved from the args. */
  determined: boolean;
}

const ACTION_VERBS = ['restart', 'rollback', 'scale', 'failover'] as const;

/** Deterministic (tool, args) → blast assessment. Infers the action from a
 *  leading verb in the runbook id (`restart-checkout-service` → restart) or
 *  an explicit `action` arg, and the service from the remainder of the id or
 *  an explicit `service` arg. Nothing here calls out, guesses, or defaults:
 *  no verb → not determined; unknown service → not determined. */
export function inferBlastAssessment(action: { tool: string; args: Record<string, unknown> }, topology: ServiceTopology): BlastInference {
  if (!BLAST_CAPABLE_TOOLS.has(action.tool)) return { determined: false };
  const args = action.args ?? {};
  const scriptName = typeof args.script_name === 'string' ? args.script_name : undefined;
  const argService = typeof args.service === 'string' ? args.service : undefined;
  const argAction =
    typeof args.action === 'string' && (ACTION_VERBS as readonly string[]).includes(args.action) ? (args.action as BlastAction) : undefined;

  let blastAction: BlastAction | undefined = argAction;
  let service = argService;
  if (scriptName) {
    const m = /^(restart|rollback|scale|failover)[-_ ](.+)$/i.exec(scriptName.trim());
    if (m) {
      blastAction ??= m[1]!.toLowerCase() as BlastAction;
      service ??= m[2]!.trim();
    }
  }
  if (!blastAction || !service) return { determined: false };
  if (!topology.knowsService(service)) return { action: blastAction, service, determined: false };
  return { action: blastAction, service, assessment: topology.assess(service, blastAction), determined: true };
}

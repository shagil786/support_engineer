/**
 * EvidenceGraph — the live incident-centered working memory.
 *
 * Deterministic and LLM-free: providers contribute typed nodes/edges, the
 * investigator reads subgraphs and cites node ids as hypothesis evidence.
 * No raw log/trace/metric payloads are ever inlined into prompts by this
 * module — `data` stays opaque on the node.
 */
import type { EvidenceEdge, EvidenceNode, EvidenceNodeKind, EvidenceSnapshot } from './types.js';

export interface CorrelatedDeployment {
  deploymentId: string;
  label: string;
  ts: number;
  leadMs: number;
}

export class EvidenceGraph {
  private readonly nodes = new Map<string, EvidenceNode>();
  private readonly edges: EvidenceEdge[] = [];

  upsert(node: EvidenceNode): EvidenceNode {
    this.nodes.set(node.id, node);
    return node;
  }

  get(id: string): EvidenceNode | undefined {
    return this.nodes.get(id);
  }

  size(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.length;
  }

  link(edge: EvidenceEdge): EvidenceEdge {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) {
      throw new Error(`EvidenceGraph: unknown edge endpoint ${edge.from} → ${edge.to}`);
    }
    this.edges.push(edge);
    return edge;
  }

  byKind(kind: EvidenceNodeKind): EvidenceNode[] {
    return [...this.nodes.values()].filter((n) => n.kind === kind);
  }

  neighbors(id: string): Array<{ edge: EvidenceEdge; node: EvidenceNode }> {
    const out: Array<{ edge: EvidenceEdge; node: EvidenceNode }> = [];
    for (const e of this.edges) {
      if (e.from === id) {
        const n = this.nodes.get(e.to);
        if (n) out.push({ edge: e, node: n });
      } else if (e.to === id) {
        const n = this.nodes.get(e.from);
        if (n) out.push({ edge: e, node: n });
      }
    }
    return out;
  }

  /** Nodes of a kind whose timestamp falls in [from, to). Timeless nodes excluded. */
  inWindow(kind: EvidenceNodeKind, from: number, to: number): EvidenceNode[] {
    return this.byKind(kind).filter((n) => n.ts !== undefined && n.ts >= from && n.ts < to);
  }

  /**
   * Deployments for a service that landed in the `lookbackMs` before `incidentTs`,
   * closest-first. This is the "errors started 3 minutes after deploy v2.41"
   * query — pure time arithmetic over graph nodes, no LLM involved.
   */
  correlatedDeploys(serviceId: string, incidentTs: number, lookbackMs: number): CorrelatedDeployment[] {
    const out: CorrelatedDeployment[] = [];
    for (const { edge, node } of this.neighbors(serviceId)) {
      if (node.kind !== 'deployment' || node.ts === undefined) continue;
      if (edge.relation !== 'correlated_with' && edge.relation !== 'caused_by') {
        // Deploy nodes are still candidates when linked at all, but a plain
        // `references` link is weaker than an explicit correlation edge.
        if (edge.relation !== 'references') continue;
      }
      const leadMs = incidentTs - node.ts;
      if (leadMs < 0 || leadMs > lookbackMs) continue;
      out.push({ deploymentId: node.id, label: node.label, ts: node.ts, leadMs });
    }
    return out.sort((a, b) => a.leadMs - b.leadMs);
  }

  snapshot(): EvidenceSnapshot {
    return { nodes: [...this.nodes.values()], edges: [...this.edges] };
  }

  static fromSnapshot(snap: EvidenceSnapshot): EvidenceGraph {
    const g = new EvidenceGraph();
    for (const n of snap.nodes) g.upsert(n);
    for (const e of snap.edges) {
      // Tolerate dangling edges from hand-built snapshots: keep the edge only
      // when both endpoints exist so `link`'s invariant holds for live use.
      if (g.get(e.from) && g.get(e.to)) g.link(e);
    }
    return g;
  }
}

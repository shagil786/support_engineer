/**
 * Evidence Graph types — the live incident-centered graph:
 * service → dependency → logs → traces → metrics → deployment → PR →
 * Jira → previous incident → runbook.
 *
 * The graph is the investigator's working memory. It never dumps raw
 * context into an LLM: hypotheses reference node ids, each with
 * supporting / contradicting evidence and a confidence.
 */
export type EvidenceNodeKind =
  | 'service'
  | 'dependency'
  | 'log'
  | 'trace'
  | 'metric'
  | 'deployment'
  | 'pr'
  | 'jira'
  | 'incident'
  | 'runbook';

export interface EvidenceNode {
  id: string;
  kind: EvidenceNodeKind;
  /** Human label, e.g. "checkout-service", "deploy v2.41", "PR #481". */
  label: string;
  /** Epoch ms when this fact became true (deploy time, log ts, ...). Absent = timeless. */
  ts?: number;
  /** Provider payload (log row, metric point, PR diff stat, ...). Opaque to the graph. */
  data?: unknown;
  /** Source that contributed this node (splunk, github, ...). For provenance. */
  source?: string;
}

export type EvidenceRelation =
  | 'depends_on'
  | 'emits'
  | 'exhibits'
  | 'caused_by'
  | 'correlated_with'
  | 'fixes'
  | 'references'
  | 'previous_incident'
  | 'mitigated_by';

export interface EvidenceEdge {
  from: string;
  to: string;
  relation: EvidenceRelation;
  /** 0..1 strength when known (e.g. 0.91 = 91% of failed traces enter payment-service). */
  weight?: number;
  note?: string;
}

export interface EvidenceSnapshot {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
}

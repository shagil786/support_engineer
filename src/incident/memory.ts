/**
 * Incident Memory — case-based reasoning over COMPLETE incident signatures.
 *
 * Beyond vector memory and procedure specs: stores symptoms, topology,
 * hypotheses attempted, failed actions, root cause, final remediation, and
 * MTTR. On a new incident: "87% similar to INC-1842; last time Redis
 * connection exhaustion was responsible."
 */
export interface IncidentSignature {
  id: string;
  service: string;
  severity: string;
  /** Symptom terms, e.g. ["checkout 500", "payment timeout"]. */
  symptoms: string[];
  /** Topology snapshot: service → dependencies. */
  topology?: Record<string, string[]>;
  hypothesesAttempted: string[];
  failedActions: string[];
  rootCause?: string;
  remediation?: string;
  /** ms from alert to mitigation. */
  mttrMs?: number;
}

export interface SimilarIncident {
  signature: IncidentSignature;
  /** 0..1 similarity. */
  similarity: number;
  /** Why it matched — auditable, term-level. */
  reasons: string[];
}

function terms(sig: IncidentSignature): Set<string> {
  const toks = new Set<string>();
  const add = (text: string): void => {
    for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length >= 3) toks.add(t);
    }
  };
  add(sig.service);
  for (const s of sig.symptoms) add(s);
  if (sig.rootCause) add(sig.rootCause);
  return toks;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarity(a: IncidentSignature, b: IncidentSignature): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const termScore = jaccard(terms(a), terms(b));
  let score = 0.7 * termScore;
  if (a.service.toLowerCase() === b.service.toLowerCase()) {
    score += 0.2;
    reasons.push(`same service ${a.service}`);
  }
  if (a.severity === b.severity) {
    score += 0.1;
    reasons.push(`same severity ${a.severity}`);
  }
  const shared = [...terms(a)].filter((t) => terms(b).has(t)).slice(0, 5);
  for (const t of shared) reasons.push(`shared term '${t}'`);
  return { score: Math.min(1, score), reasons };
}

export class IncidentMemory {
  private readonly cases: IncidentSignature[] = [];

  store(sig: IncidentSignature): void {
    const idx = this.cases.findIndex((c) => c.id === sig.id);
    if (idx >= 0) this.cases[idx] = sig;
    else this.cases.push(sig);
  }

  size(): number {
    return this.cases.length;
  }

  /** Past incidents ranked by similarity to the new incident (excludes self). */
  findSimilar(query: IncidentSignature, topK = 3): SimilarIncident[] {
    return this.cases
      .filter((c) => c.id !== query.id)
      .map((c) => {
        const { score, reasons } = similarity(query, c);
        return { signature: c, similarity: score, reasons };
      })
      .filter((r) => r.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.max(1, topK));
  }

  /** One-line recall for the investigator prompt / timeline. */
  recallLine(query: IncidentSignature): string | undefined {
    const [best] = this.findSimilar(query, 1);
    if (!best || best.similarity < 0.3) return undefined;
    const cause = best.signature.rootCause ?? 'unknown cause';
    return `${Math.round(best.similarity * 100)}% similar to ${best.signature.id}; last time ${cause} was responsible.`;
  }
}

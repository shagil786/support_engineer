/**
 * Change-intel provider ports — GitHub + CI/CD as injected interfaces.
 *
 * Like LogProvider/RunbookProvider: the platform never constructs HTTP
 * clients itself. Hosts inject these; unwired → the correlator degrades
 * honestly (no suspects, never invented PRs).
 */
export interface ChangeRecord {
  id: string;
  /** e.g. "PR #481", "deploy v2.41", "flag checkout-new-timeout=on". */
  label: string;
  /** What changed. */
  kind: 'pr' | 'deploy' | 'config' | 'flag';
  /** Epoch ms when it landed. */
  ts: number;
  service?: string;
  author?: string;
  /** Files touched (for stack-trace → symbol mapping). */
  files?: string[];
  /** Human summary of the diff. */
  summary?: string;
}

export interface ChangeProvider {
  readonly name: string;
  /** Recent changes for a service, newest-first. Window filtering is the host's job. */
  recentChanges(service: string, opts?: { since?: number; limit?: number }): Promise<ChangeRecord[]>;
}

export interface CorrelatedSuspect {
  change: ChangeRecord;
  /** ms between the change landing and the incident start. Negative = after. */
  leadMs: number;
  /** 0..1 suspicion. */
  suspicion: number;
  reasons: string[];
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Rank recent changes by temporal proximity to the incident plus textual
 * overlap with the incident's signals (service name, error terms, trace
 * frames). Deterministic: recency decays linearly over the lookback, each
 * matching signal term adds 0.1, touching an implicated file adds 0.15.
 */
export function correlateChanges(
  changes: ChangeRecord[],
  opts: { incidentTs: number; lookbackMs: number; signals?: string[]; files?: string[] },
): CorrelatedSuspect[] {
  const signals = (opts.signals ?? []).map((s) => s.toLowerCase()).filter((s) => s.length > 0);
  const files = new Set((opts.files ?? []).map((f) => f.toLowerCase()));
  const out: CorrelatedSuspect[] = [];
  for (const change of changes) {
    const leadMs = opts.incidentTs - change.ts;
    if (leadMs < 0 || leadMs > opts.lookbackMs) continue;
    const reasons: string[] = [`landed ${Math.round(leadMs / 60000)}m before incident`];
    const recency = 1 - leadMs / opts.lookbackMs;
    let bonus = 0;
    const hay = `${change.label} ${change.summary ?? ''} ${(change.files ?? []).join(' ')}`.toLowerCase();
    for (const sig of signals) {
      if (sig.length >= 3 && hay.includes(sig)) {
        bonus += 0.1;
        reasons.push(`mentions '${sig}'`);
      }
    }
    for (const f of change.files ?? []) {
      if (files.has(f.toLowerCase())) {
        bonus += 0.15;
        reasons.push(`touches implicated file ${f}`);
        break;
      }
    }
    if (change.kind === 'deploy') {
      bonus += 0.05;
      reasons.push('is a deployment');
    }
    out.push({ change, leadMs, suspicion: clamp01(0.2 + 0.5 * recency + bonus), reasons });
  }
  return out.sort((a, b) => b.suspicion - a.suspicion);
}

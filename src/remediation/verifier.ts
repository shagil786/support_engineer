/**
 * Verified remediation — success criteria evaluated AFTER an action, not
 * "command succeeded".
 *
 * Flow: restart payment-service → wait 90s → error rate <1% → p95 restored
 * → synthetic checkout succeeds → mitigation confirmed. Failure rolls back
 * or escalates. Deterministic evaluation over provider reads; the policy
 * for rollback vs escalate is data (RemediationPolicy), not code.
 */
import type { MetricsProvider } from '../signals/types.js';

export interface SuccessCriterion {
  /** Metric kind to read, e.g. "error_rate", "p95_latency_ms". */
  metric: string;
  /** Comparison against threshold. */
  op: 'lt' | 'lte' | 'gt' | 'gte';
  threshold: number;
  /** Human label for the incident timeline, e.g. "error rate < 1%". */
  label: string;
}

export interface RemediationPolicy {
  service: string;
  /** Post-action settle time before reading metrics. */
  settleMs: number;
  criteria: SuccessCriterion[];
  /** Synthetic check to run last (e.g. synthetic checkout). Absent = metrics only. */
  synthetic?: { name: string };
  /** What to do when verification fails. */
  onFailure: 'rollback' | 'escalate';
  /** Rollback runbook id when onFailure === 'rollback'. */
  rollbackRunbookId?: string;
}

export interface VerificationReading {
  criterion: SuccessCriterion;
  observed?: number;
  passed: boolean;
  detail: string;
}

export interface RemediationVerdict {
  service: string;
  passed: boolean;
  readings: VerificationReading[];
  synthetic?: { name: string; ok: boolean };
  /** Next step when !passed: rollback runbook id or 'escalate'. */
  next: string;
  timeline: string[];
}

export interface RemediationPorts {
  metrics?: MetricsProvider;
  /** Runs a named synthetic check. Unwired → synthetic criterion skipped honestly. */
  synthetic?: (name: string) => Promise<boolean>;
  now?: () => number;
  /** Wait between action and verification. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

function test(op: SuccessCriterion['op'], observed: number, threshold: number): boolean {
  switch (op) {
    case 'lt': return observed < threshold;
    case 'lte': return observed <= threshold;
    case 'gt': return observed > threshold;
    case 'gte': return observed >= threshold;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Evaluate a remediation policy after an action completed. Reads each
 * criterion's metric at (now - settleMs, now), runs the synthetic last, and
 * returns a verdict with a timeline. Never throws for unwired providers:
 * an unreadable metric is a FAILED reading (fail-closed — an unverified
 * remediation must not read as "confirmed").
 */
export async function verifyRemediation(
  policy: RemediationPolicy,
  ports: RemediationPorts = {},
): Promise<RemediationVerdict> {
  const now = ports.now ?? Date.now;
  const sleep = ports.sleep ?? defaultSleep;
  const timeline: string[] = [`waiting ${Math.round(policy.settleMs / 1000)}s settle for ${policy.service}`];
  if (policy.settleMs > 0) await sleep(policy.settleMs);

  const to = now();
  const from = to - Math.max(policy.settleMs, 60_000);
  const readings: VerificationReading[] = [];
  for (const criterion of policy.criteria) {
    let observed: number | undefined;
    let detail: string;
    try {
      const series = await ports.metrics?.query(policy.service, criterion.metric, from, to);
      const pts = series?.points ?? [];
      observed = pts.length > 0 ? pts[pts.length - 1]?.value : undefined;
      detail = observed === undefined ? 'no data' : `${criterion.metric}=${observed}`;
    } catch (e) {
      detail = `read failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    const passed = observed !== undefined && test(criterion.op, observed, criterion.threshold);
    readings.push({ criterion, ...(observed !== undefined ? { observed } : {}), passed, detail });
    timeline.push(`${passed ? 'PASS' : 'FAIL'} ${criterion.label} (${detail})`);
  }

  let synthetic: RemediationVerdict['synthetic'];
  if (policy.synthetic) {
    if (!ports.synthetic) {
      synthetic = { name: policy.synthetic.name, ok: false };
      timeline.push(`SKIP synthetic ${policy.synthetic.name} (no synthetic runner wired)`);
    } else {
      try {
        const ok = await ports.synthetic(policy.synthetic.name);
        synthetic = { name: policy.synthetic.name, ok };
        timeline.push(`${ok ? 'PASS' : 'FAIL'} synthetic ${policy.synthetic.name}`);
      } catch (e) {
        synthetic = { name: policy.synthetic.name, ok: false };
        timeline.push(`FAIL synthetic ${policy.synthetic.name} (threw: ${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }

  const metricsOk = readings.every((r) => r.passed);
  const syntheticOk = synthetic === undefined || synthetic.ok;
  const passed = metricsOk && syntheticOk;
  const next = passed
    ? 'confirmed'
    : policy.onFailure === 'rollback'
      ? (policy.rollbackRunbookId ?? 'rollback')
      : 'escalate';
  timeline.push(passed ? 'incident mitigation confirmed' : `verification failed → ${next}`);
  return { service: policy.service, passed, readings, ...(synthetic ? { synthetic } : {}), next, timeline };
}

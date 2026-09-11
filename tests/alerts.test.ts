/**
 * The alerting rules (deploy/prometheus/support-agent-alerts.yml) are a
 * hand-written consumer of the /metrics contract, like the Grafana
 * dashboard. These tests pin the contract so a metric rename in the
 * renderer fails CI here instead of silently disabling production alerting,
 * and so every rule stays structurally sound (severity, for-duration, the
 * backlog arithmetic including denials).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { JsonlFileEventLog } from '../src/event-log/log';
import { renderMetrics } from '../src/http/metrics';

const rulesPath = join(__dirname, '..', 'deploy', 'prometheus', 'support-agent-alerts.yml');

interface Rule {
  alert: string;
  expr: string;
  for?: string;
  labels: { severity?: string; service?: string };
  annotations: Record<string, string>;
}
interface Group {
  name: string;
  interval?: string;
  rules: Rule[];
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alerts-contract-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Seed one event per charted kind (including both saturation signals) and render. */
async function seededRender(): Promise<string> {
  const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
  const base = { correlationId: 'c', layer: 'execution' as const, source: 'internal' as const };
  const gov = { correlationId: 'c', layer: 'governance' as const, source: 'internal' as const };
  await log.append({ ...base, ts: 1, kind: 'llm_call', model: 'gpt-4o', latencyMs: 120, attempts: 1, ok: true, promptTokens: 100, completionTokens: 50 });
  await log.append({ ...base, ts: 2, kind: 'llm_call', model: 'gpt-4o', latencyMs: 2000, attempts: 3, ok: false, errorCode: 'http_error' });
  await log.append({ ...base, ts: 3, kind: 'llm_call', model: 'gpt-4o', latencyMs: 0, attempts: 0, ok: false, errorCode: 'circuit_open' });
  await log.append({ ...base, ts: 4, kind: 'tool_call', tool: 'query_logs', args: {}, result: { ok: true, data: {} }, latencyMs: 40, attempts: 1 });
  await log.append({ ...gov, ts: 5, kind: 'safety_net', vetoed: true, check: 'cost_cap', reason: 'r' });
  await log.append({ ...gov, ts: 6, kind: 'approval_request', approvalId: 'a1', policyId: 'p1', approver_count: 2 });
  await log.append({ ...gov, ts: 7, kind: 'approval_granted', approvalId: 'a1', signerRole: 'admin' });
  await log.append({ ...gov, ts: 8, kind: 'approval_denied', approvalId: 'a2' });
  await log.append({ ...gov, ts: 9, kind: 'approval_timeout', approvalId: 'a3' });
  // Review-retry recovery: one recovered, one failed — the recovery-rate
  // alert's ratio needs both outcomes present in the seeded render.
  await log.append({ ...base, ts: 10, kind: 'agent_outcome', finalResult: { ok: true, summary: 'recovered' }, stats: { source: 'pipeline', hops: 3, toolCalls: 2, wallClockMs: 900, reviewRetries: 1 } });
  await log.append({ ...base, ts: 11, kind: 'agent_outcome', finalResult: { ok: false, summary: 'retried then failed' }, stats: { source: 'pipeline', hops: 5, toolCalls: 4, wallClockMs: 1500, reviewRetries: 2 } });
  return renderMetrics(log);
}

function loadRules(): Group[] {
  const doc = parse(readFileSync(rulesPath, 'utf8')) as { groups: Group[] };
  return doc.groups;
}

/** Base family name of a referenced metric (strip histogram sub-metrics). */
function baseFamily(metric: string): string {
  return metric.replace(/_(bucket|sum|count)$/, '');
}

describe('Prometheus alert rules ↔ /metrics contract', () => {
  const rules = loadRules().flatMap((g) => g.rules);

  it('contains the alert classes', () => {
    const names = rules.map((r) => r.alert);
    expect(names).toEqual(
      expect.arrayContaining(['SupportAgentLlmSaturation', 'SupportAgentLlmCircuitOpen', 'SupportAgentApprovalBacklog', 'SupportAgentVetoSpike', 'SupportAgentReviewRecoveryLow']),
    );
  });

  it('every referenced metric family exists in the rendered output', async () => {
    const text = await seededRender();
    const emitted = new Set([...text.matchAll(/^# TYPE (\w+) \w+$/gm)].map((m) => m[1]!));
    const referenced = new Set<string>();
    for (const r of rules) {
      for (const m of r.expr.matchAll(/support_agent_[a-z_]+/g)) referenced.add(baseFamily(m[0]));
    }
    const missing = [...referenced].filter((f) => !emitted.has(f));
    expect(missing, `rules reference metrics the renderer never emits: ${missing.join(', ')}`).toEqual([]);
  });

  it('every referenced label key exists in the rendered output', async () => {
    const text = await seededRender();
    const referenced = new Set<string>();
    for (const r of rules) {
      for (const m of r.expr.matchAll(/(\w+)="[^\"]*"/g)) {
        if (m[1] !== 'le' && m[1] !== 'job' && m[1] !== 'instance') referenced.add(m[1]!);
      }
    }
    const missing = [...referenced].filter((k) => !text.includes(`${k}="`));
    expect(missing, `rules reference labels the renderer never emits: ${missing.join(', ')}`).toEqual([]);
  });

  it('every rule carries a severity and service label', () => {
    for (const r of rules) {
      expect(['warning', 'critical'], `${r.alert} severity`).toContain(r.labels.severity);
      expect(r.labels.service, `${r.alert} service`).toBe('support-agent');
      expect(r.annotations.summary, `${r.alert} summary`).toBeTruthy();
      expect(r.annotations.description, `${r.alert} description`).toBeTruthy();
    }
  });

  it('rate-based alerts have a for-duration (veto spike uses a window increase instead)', () => {
    for (const r of rules) {
      if (r.expr.includes('rate(')) expect(r.for, `${r.alert} needs a for:`).toBeTruthy();
    }
    expect(rules.find((r) => r.alert === 'SupportAgentVetoSpike')?.for).toBeUndefined();
  });

  it('the backlog arithmetic counts denials as terminal (the approval_denied fix)', () => {
    const backlog = rules.find((r) => r.alert === 'SupportAgentApprovalBacklog');
    expect(backlog).toBeDefined();
    for (const outcome of ['requested', 'granted', 'denied', 'timed_out']) {
      expect(backlog!.expr, `backlog must subtract outcome="${outcome}"`).toContain(`outcome="${outcome}"`);
    }
    // executed is a SUBSET of granted (an approval is granted before it can
    // execute) — subtracting it too would double-count and understate, even
    // go negative. The queue-drain alerting stays granted-based.
    expect(backlog!.expr).not.toContain('outcome="executed"');
  });

  it('the recovery-rate alert divides recovered by retried (ratio arithmetic pin)', async () => {
    const text = await seededRender();
    const recovery = rules.find((r) => r.alert === 'SupportAgentReviewRecoveryLow');
    expect(recovery).toBeDefined();
    // Both sides of the ratio must reference the family the renderer emits,
    // with the exact label values the renderer pins.
    expect(recovery!.expr).toContain('support_agent_review_retries_total');
    expect(recovery!.expr).toContain('outcome="recovered"');
    expect(recovery!.expr).toContain('outcome="retried"');
    // `failed` and `granted` must never leak into the ratio: failed is a
    // subset of retried (double-counting understates recovery), granted is
    // the approvals family (a typo would cross-wire two lifecycles).
    expect(recovery!.expr).not.toContain('outcome="failed"');
    expect(recovery!.expr).not.toContain('approvals_total');
    // And the renderer really emits both label values, so the alert can
    // never be silently absent due to a label typo on the renderer side.
    expect(text).toContain('support_agent_review_retries_total{outcome="recovered"}');
    expect(text).toContain('support_agent_review_retries_total{outcome="retried"}');
  });

  it('saturation alerting uses the two real failure signals (error codes, not guesses)', async () => {
    const text = await seededRender();
    const saturation = rules.find((r) => r.alert === 'SupportAgentLlmCircuitOpen');
    expect(saturation!.expr).toContain('error_code="circuit_open"');
    // circuit_open is a real emitted label value (the breaker's fail-fast).
    expect(text).toContain('error_code="circuit_open"');
  });
});

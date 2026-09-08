/**
 * The Grafana dashboard (deploy/grafana/support-agent-dashboard.json) is a
 * hand-written consumer of the /metrics contract. These tests pin the
 * contract in both directions so a rename on either side fails CI instead of
 * silently blanking panels in production:
 *
 *  1. forward: the dashboard only references metric names / label keys that
 *     the renderer actually emits.
 *  2. reverse: every metric family the renderer emits is charted somewhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventLog } from '../src/event-log/log';
import { renderMetrics } from '../src/http/metrics';

const dashboardPath = join(__dirname, '..', 'deploy', 'grafana', 'support-agent-dashboard.json');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dashboard-contract-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Seed one event of every charted kind and return the rendered text. */
async function seededRender(): Promise<string> {
  const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
  const cid = 'c';
  const base = { correlationId: cid, layer: 'execution' as const, source: 'internal' as const };
  await log.append({ ...base, ts: 1, kind: 'llm_call', model: 'gpt-4o', latencyMs: 120, attempts: 1, ok: true, promptTokens: 100, completionTokens: 50 });
  await log.append({ ...base, ts: 2, kind: 'llm_call', model: 'gpt-4o', latencyMs: 2000, attempts: 3, ok: false, errorCode: 'http_error' });
  await log.append({ ...base, ts: 3, kind: 'tool_call', tool: 'query_logs', args: {}, result: { ok: true, data: {} }, latencyMs: 40, attempts: 1 });
  await log.append({ ...base, ts: 4, kind: 'agent_outcome', finalResult: { ok: true, summary: 'did the thing' } });
  await log.append({ correlationId: cid, layer: 'governance' as const, source: 'internal' as const, ts: 5, kind: 'governance', intent: { kind: 'meeting_response', subKind: 'complaint' } as never, decision: { effect: 'allow', reason: 'r', policyIds: ['p1'] } });
  await log.append({ correlationId: cid, layer: 'governance' as const, source: 'internal' as const, ts: 6, kind: 'safety_net', vetoed: true, check: 'rbac', reason: 'r' });
  await log.append({ correlationId: cid, layer: 'governance' as const, source: 'internal' as const, ts: 7, kind: 'approval_request', approvalId: 'a1', policyId: 'p1', approver_count: 2 });
  return renderMetrics(log);
}

/** Every Prometheus identifier referenced anywhere in the dashboard JSON. */
function metricRefsFromDashboard(): { names: Set<string>; labelKeys: Set<string> } {
  const raw = readFileSync(dashboardPath, 'utf8');
  const names = new Set<string>([...raw.matchAll(/support_agent_[a-z_]+/g)].map((m) => m[0]!));
  const labelKeys = new Set<string>([...raw.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!));
  return { names, labelKeys };
}

describe('Grafana dashboard ↔ /metrics contract', () => {
  it('is valid JSON with the pinned import coordinates', () => {
    const d = JSON.parse(readFileSync(dashboardPath, 'utf8')) as { title: string; uid: string; panels: unknown[] };
    expect(d.uid).toBe('support-agent-ops');
    expect(d.title).toContain('Support Agent');
    expect(d.panels.length).toBeGreaterThan(10);
  });

  it('every dashboard metric reference exists in the rendered output (forward pin)', async () => {
    const text = await seededRender();
    const emitted = new Set([...text.matchAll(/^# TYPE (\w+) \w+$/gm)].map((m) => m[1]!));
    const { names } = metricRefsFromDashboard();
    const missing = [...names].filter(
      (n) => ![...emitted].some((e) => n === e || n.startsWith(`${e}_`)),
    );
    expect(missing, `dashboard references metrics the renderer never emits: ${missing.join(', ')}`).toEqual([]);
  });

  it('every rendered family is charted by the dashboard (reverse pin)', async () => {
    const text = await seededRender();
    const emitted = new Set([...text.matchAll(/^# TYPE (\w+) \w+$/gm)].map((m) => m[1]!));
    const { names } = metricRefsFromDashboard();
    const uncharted = [...emitted].filter(
      (f) => ![...names].some((n) => n === f || n.startsWith(`${f}_`)),
    );
    expect(uncharted, `renderer emits families the dashboard never charts: ${uncharted.join(', ')}`).toEqual([]);
  });

  it('dashboard templating only uses label keys the renderer emits ({{model}}, {{ok}}, …)', async () => {
    const text = await seededRender();
    const { labelKeys } = metricRefsFromDashboard();
    const missing = [...labelKeys].filter((k) => !text.includes(`${k}="`));
    expect(missing, `dashboard legend templates reference labels the renderer never emits: ${missing.join(', ')}`).toEqual([]);
  });
});

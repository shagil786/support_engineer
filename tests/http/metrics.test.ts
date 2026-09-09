import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { renderMetrics } from '../../src/http/metrics';
import { createPlatform } from '../../src/bootstrap';
import { createHttpServer } from '../../src/http/server';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'metrics-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('renderMetrics', () => {
  it('aggregates llm_call, tool_call, agent_outcome, governance, safety_net and approval events', async () => {
    const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
    const cid = 'c1';
    await log.append({ correlationId: cid, ts: 1, layer: 'execution', source: 'internal', kind: 'llm_call', model: 'gpt-4o', latencyMs: 120, attempts: 1, ok: true, promptTokens: 100, completionTokens: 50 });
    await log.append({ correlationId: cid, ts: 2, layer: 'execution', source: 'internal', kind: 'llm_call', model: 'gpt-4o', latencyMs: 2000, attempts: 3, ok: false, errorCode: 'http_error' });
    await log.append({ correlationId: cid, ts: 3, layer: 'execution', source: 'internal', kind: 'tool_call', tool: 'query_logs', args: {}, result: { ok: true, data: {} }, latencyMs: 40, attempts: 1 });
    await log.append({ correlationId: cid, ts: 4, layer: 'execution', source: 'internal', kind: 'tool_call', tool: 'query_logs', args: {}, result: { ok: false, error: 'down' }, latencyMs: 800, attempts: 2 });
    await log.append({ correlationId: cid, ts: 5, layer: 'execution', source: 'internal', kind: 'agent_outcome', finalResult: { ok: true, summary: 'did the thing' } });
    await log.append({ correlationId: cid, ts: 6, layer: 'execution', source: 'internal', kind: 'agent_outcome', finalResult: { ok: false, summary: 'failed' } });
    await log.append({ correlationId: cid, ts: 7, layer: 'governance', source: 'internal', kind: 'governance', intent: { kind: 'meeting_response', subKind: 'complaint' } as never, decision: { effect: 'allow', reason: 'r', policyIds: ['p1'] } });
    await log.append({ correlationId: cid, ts: 8, layer: 'governance', source: 'internal', kind: 'governance', intent: { kind: 'meeting_response', subKind: 'complaint' } as never, decision: { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] } });
    await log.append({ correlationId: cid, ts: 9, layer: 'governance', source: 'internal', kind: 'safety_net', vetoed: true, check: 'rbac', reason: 'guest cannot run destructive' });
    await log.append({ correlationId: cid, ts: 10, layer: 'governance', source: 'internal', kind: 'safety_net', vetoed: false, check: 'rbac', reason: 'ok' });
    await log.append({ correlationId: cid, ts: 11, layer: 'governance', source: 'internal', kind: 'approval_request', approvalId: 'a1', policyId: 'p1', approver_count: 2 });
    await log.append({ correlationId: cid, ts: 12, layer: 'governance', source: 'internal', kind: 'approval_granted', approvalId: 'a1', signerRole: 'admin' });
    await log.append({ correlationId: cid, ts: 13, layer: 'governance', source: 'internal', kind: 'approval_timeout', approvalId: 'a2' });
    await log.append({ correlationId: cid, ts: 14, layer: 'governance', source: 'slack', kind: 'approval_denied', approvalId: 'a3' });
    await log.append({ correlationId: cid, ts: 15, layer: 'governance', source: 'internal', kind: 'approval_executed', approvalId: 'a1' });

    const text = await renderMetrics(log);

    expect(text).toContain('support_agent_llm_calls_total{model="gpt-4o",ok="true"} 1');
    expect(text).toContain('support_agent_llm_calls_total{model="gpt-4o",ok="false",error_code="http_error"} 1');
    expect(text).toContain('support_agent_llm_tokens_total{model="gpt-4o"} 150');
    // Histogram: both calls in <=2500 buckets; cumulative buckets are honest.
    expect(text).toContain('support_agent_llm_latency_ms_bucket{le="500"} 1');
    expect(text).toContain('support_agent_llm_latency_ms_bucket{le="2500"} 2');
    expect(text).toContain('support_agent_llm_latency_ms_bucket{le="+Inf"} 2');
    expect(text).toContain('support_agent_llm_latency_ms_sum 2120');
    expect(text).toContain('support_agent_llm_latency_ms_count 2');
    expect(text).toContain('support_agent_tool_calls_total{tool="query_logs",ok="true"} 1');
    expect(text).toContain('support_agent_tool_calls_total{tool="query_logs",ok="false"} 1');
    expect(text).toContain('support_agent_tool_latency_ms_bucket{tool="query_logs",le="100"} 1');
    expect(text).toContain('support_agent_tool_latency_ms_bucket{tool="query_logs",le="1000"} 2');
    expect(text).toContain('support_agent_agent_outcomes_total{ok="true"} 1');
    expect(text).toContain('support_agent_agent_outcomes_total{ok="false"} 1');
    expect(text).toContain('support_agent_governance_decisions_total{effect="allow"} 1');
    expect(text).toContain('support_agent_governance_decisions_total{effect="require_approval"} 1');
    expect(text).toContain('support_agent_safety_net_vetoes_total{check="rbac"} 1');
    expect(text).toContain('support_agent_approvals_total{outcome="requested"} 1');
    expect(text).toContain('support_agent_approvals_total{outcome="granted"} 1');
    expect(text).toContain('support_agent_approvals_total{outcome="denied"} 1');
    expect(text).toContain('support_agent_approvals_total{outcome="timed_out"} 1');
    expect(text).toContain('support_agent_approvals_total{outcome="executed"} 1');
  });

  it('renders a valid (empty) body when the log has no events', async () => {
    const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
    const text = await renderMetrics(log);
    expect(text).toContain('support_agent_agent_outcomes_total{ok="true"} 0');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes quotes and backslashes in label values', async () => {
    const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
    await log.append({ correlationId: 'c', ts: 1, layer: 'governance', source: 'internal', kind: 'safety_net', vetoed: true, check: 'weird"check\\x', reason: 'r' });
    const text = await renderMetrics(log);
    expect(text).toContain('support_agent_safety_net_vetoes_total{check="weird\\"check\\\\x"} 1');
  });
});

describe('GET /metrics route', () => {
  it('serves Prometheus text behind bearer auth and fails closed', async () => {
    const p = createPlatform({ dataDir: dir, runbooks: [{ id: 'rb', name: 'rb', description: 'restart the checkout pod', destructive: false }] });
    const h = await createHttpServer(p, { authTokens: ['tok-1'] });
    try {
      const noAuth = await fetch(`${h.url}/metrics`);
      expect(noAuth.status).toBe(401);

      const res = await fetch(`${h.url}/metrics`, { headers: { authorization: 'Bearer tok-1' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const body = await res.text();
      expect(body).toContain('# TYPE support_agent_llm_calls_total counter');
      // The catalog auto-ingest produces no llm events, but the family exists.
      expect(body).toContain('support_agent_llm_calls_total');
    } finally {
      await h.close();
    }
  });
});

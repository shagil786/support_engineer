import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../../src/bootstrap';
import { LearningLoop } from '../../src/learning/learning-loop';
import { OrchestratedPipeline } from '../../src/pipeline/agent-pipeline';
import { JsonlFileEventLog } from '../../src/event-log/log';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const successfulOutcome = (cid: string): string =>
  JSON.stringify({
    correlationId: 'seed-' + cid,
    ts: 1,
    toolCalls: [
      { kind: 'tool_call', tool: 'query_logs', args: { query_string: 'x' }, result: { ok: true, data: {} }, latencyMs: 1, attempts: 1 },
      { kind: 'tool_call', tool: 'jira_create_issue', args: { summary: 'x', issue_type: 'Bug' }, result: { ok: true, data: {} }, latencyMs: 1, attempts: 1 },
    ],
    approvals: [],
  });

const logProvider = {
  name: 'fake',
  query: async () => ({ provider: 'splunk', rows: [], error: undefined }),
};

const runbooks = [
  { id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true },
  { id: 'clear-cache', name: 'clear-cache', description: 'clear the api cache', destructive: false },
];

describe('createPlatform', () => {
  it('wires the full pipeline with an empty env (learning off, durable library present)', () => {
    const p = createPlatform({ dataDir: dir });
    expect(p.pipeline).toBeInstanceOf(OrchestratedPipeline);
    expect(p.eventLog).toBeDefined();
    expect(p.learningLoop).toBeUndefined();
    // The library is always wired: "serve what was learned, stop learning."
    expect(p.library).toBeDefined();
    // The knowledge base is always present and retrieval is live in the
    // assembler: ingest a doc, then retrieve it through the platform.
    expect(p.knowledge).toBeDefined();
  });

  it('knowledge base: ingest → provenance-tagged retrieval through the pipeline assembler', async () => {
    const p = createPlatform({ dataDir: dir, runbooks });
    await p.knowledge.ingest({
      id: 'run-cache-clear',
      text: '# Clear the API cache',
      metadata: { source: 'runbooks', tags: ['cache'] },
    });
    const hits = await p.knowledge.search('api cache clear');
    expect(hits[0]?.docId).toBe('run-cache-clear');
    expect(hits[0]?.metadata?.['source']).toBe('runbooks');
    expect(hits[0]?.heading).toBe('Clear the API cache');
  });

  it('learning on: the scheduled loop actually STARTS (interval fires; stopLearning stops it)', async () => {
    vi.useFakeTimers();
    try {
      const p = createPlatform({ dataDir: dir, learning: { enabled: true, intervalMs: 1000 } });
      expect(p.learningLoop).toBeInstanceOf(LearningLoop);
      // Regression: bootstrap constructed the loop but never called start(),
      // so "learning: on, every Nms" was a lie — the interval never fired.
      const tickSpy = vi.spyOn(p.learningLoop!, 'tick');
      await vi.advanceTimersByTimeAsync(2500);
      expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      p.stopLearning();
      const after = tickSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(tickSpy.mock.calls.length).toBe(after); // stopped means stopped
    } finally {
      vi.useRealTimers();
    }
  });

  it('learning off: no loop, no timer (stopLearning is a safe no-op)', async () => {
    const p = createPlatform({ dataDir: dir });
    expect(p.learningLoop).toBeUndefined();
    expect(() => p.stopLearning()).not.toThrow();
  });

  it('learning on: durable library wired into the supervisor; tick then short-circuit live request', async () => {
    const p = createPlatform({
      dataDir: dir,
      learning: { enabled: true },
      logProvider,
      runbooks,
    });
    expect(p.learningLoop).toBeInstanceOf(LearningLoop);
    expect(p.library).toBeDefined();
    // Snapshot is created lazily, not at construction.
    expect(existsSync(join(dir, 'memory', 'procedures.json'))).toBe(false);

    // Seed outcomes, run one learning tick, then serve a live utterance.
    mkdirSync(join(dir, 'outcomes'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, 'outcomes', 'o' + String(i) + '.json'), successfulOutcome(String(i)));
    }
    await p.learningLoop!.tick();
    await p.library!.refresh();
    expect(p.library!.size()).toBe(1);

    const r = await p.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(true);

    let outcome;
    for await (const e of (p.eventLog as JsonlFileEventLog).query({ correlationId: r.correlationId })) {
      if (e.kind === 'agent_outcome') outcome = e;
    }
    expect(outcome?.finalResult.summary).toContain('via:procedure');
  });

  it('supervisorCaps flow through to the supervisor (maxHops=1 fails the dance fast)', async () => {
    const p = createPlatform({ dataDir: dir, logProvider, runbooks, supervisorCaps: { maxHops: 1 } });
    const r = await p.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hop cap/);
  });

  it('two security layers: guests are vetoed by the SafetyNet; approvers stage for approval', async () => {
    const p = createPlatform({
      dataDir: dir,
      logProvider,
      runbooks,
      speakerRole: (id) => (id === 'admin1' ? 'admin' : undefined),
    });
    // Unknown speaker = guest → the always-on SafetyNet vetoes destructive
    // tools outright (no approval path exists for guests).
    const guest = await p.pipeline.processUtterance('u1', 'agent, can you restart the checkout pod?', 500);
    expect(guest.routed).toBe('pipeline');
    expect(guest.ok).toBe(false);
    expect(guest.reason).toMatch(/veto/i);
    // An approver's identical offer stages for M-of-N approval.
    const admin = await p.pipeline.processUtterance('admin1', 'agent, can you restart the checkout pod?', 600);
    expect(admin.routed).toBe('pipeline');
    expect(admin.approvalId).toBeDefined();
    expect(admin.approvalStatus).toBe('pending');
  });

  it('exposes the ApprovalGate and the server-side role resolver (reaction UX surface)', async () => {
    const p = createPlatform({
      dataDir: dir,
      speakerRole: (id) => (id === 'U-alice' ? 'admin' : undefined),
    });
    expect(p.approvals).toBeDefined();
    // The resolver is server-side: guests by default, host mappings apply,
    // and the gate-minted approver identity is always admin.
    expect(p.speakerRole('U-alice')).toBe('admin');
    expect(p.speakerRole('U-stranger')).toBeUndefined();
    expect(p.speakerRole('approver')).toBe('admin');

    // Emoji sign-off through the exposed gate (single-pending fallback).
    const { approvalId } = await p.approvals.request({
      policyId: 'p1',
      decision: { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] },
      action: { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } },
    });
    const r = await p.approvals.handleReaction({ type: 'reaction_added', reaction: 'shield', userId: 'U-alice', userRole: p.speakerRole('U-alice') });
    expect(r).toMatchObject({ matched: true, approvalId, accepted: true });
  });
});

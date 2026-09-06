import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});

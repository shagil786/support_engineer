import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServeRuntime } from '../../scripts/serve';
import type { ServeRuntime } from '../../scripts/serve';
import { FileBackedVectorMemory } from '../../src/understanding/memory/file-backed';
import { hashEmbedder } from '../../src/understanding/memory/vector';
import type { ProcedureSpec } from '../../src/learning/knowledge-extractor';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'serve-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const logProvider = {
  name: 'fake',
  query: async () => ({ provider: 'splunk', rows: [], error: undefined }),
};

const runbooks = [
  { id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true },
  { id: 'clear-cache', name: 'clear-cache', description: 'clear the api cache', destructive: false },
];

describe('createServeRuntime', () => {
  it('builds a runtime whose pipeline serves real utterances', async () => {
    const rt: ServeRuntime = createServeRuntime({ dataDir: dir, logProvider, runbooks });
    const r = await rt.platform.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(true);
  });

  it('a procedure seeded into durable memory reaches the supervisor (composition path)', async () => {
    const rt = createServeRuntime({ dataDir: dir, logProvider, runbooks });
    const fb = new FileBackedVectorMemory({
      path: join(dir, 'memory', 'procedures.json'),
      embedder: hashEmbedder,
    });
    const proc: ProcedureSpec = {
      id: 'proc-query-logs-only',
      trigger: 'query_logs',
      steps: [{ agent: 'investigator', tool: 'query_logs', args: { query_string: 'seeded' } }],
      successRate: 1,
      sampleSize: 3,
    };
    await fb.add({ id: proc.id, text: 'procedure: ' + proc.trigger, metadata: { procedure: proc } });
    await rt.platform.library!.refresh();

    const r = await rt.platform.pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('stopLearning() cleanly stops the scheduled loop', () => {
    const rt = createServeRuntime({
      dataDir: dir,
      logProvider,
      runbooks,
      learning: { enabled: true, intervalMs: 60_000 },
    });
    expect(rt.platform.learningLoop).toBeDefined();
    expect(() => rt.stopLearning()).not.toThrow();
  });
});

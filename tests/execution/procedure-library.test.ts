import { describe, it, expect } from 'vitest';
import { ProcedureLibrary } from '../../src/execution/procedure-library';
import { EpisodicMemory } from '../../src/understanding/memory/episodic';
import type { ProcedureSpec } from '../../src/learning/knowledge-extractor';

const spec = (over: Partial<ProcedureSpec> = {}): ProcedureSpec => ({
  id: 'proc-query-logs-jira-create-issue',
  trigger: 'query_logs → jira_create_issue',
  steps: [
    { agent: 'investigator', tool: 'query_logs', args: { query_string: 'old' } },
    { agent: 'investigator', tool: 'jira_create_issue', args: { summary: 'HISTORICAL ARGS' } },
  ],
  successRate: 1,
  sampleSize: 5,
  ...over,
});

async function loadedLib(...specs: ProcedureSpec[]): Promise<ProcedureLibrary> {
  const episodic = new EpisodicMemory({});
  const lib = new ProcedureLibrary({ episodic });
  for (const s of specs) {
    await episodic.record('cross', { id: s.id, text: `procedure: ${s.trigger}`, metadata: { procedure: s } });
  }
  await lib.refresh();
  return lib;
}

describe('ProcedureLibrary', () => {
  it('matches a request whose action tool leads a learned procedure', async () => {
    const lib = await loadedLib(spec());
    const m = await lib.match('query_logs');
    expect(m?.procedure.id).toBe('proc-query-logs-jira-create-issue');
    // Leading step is the request itself; replay is the remainder.
    expect(m?.leading).toEqual({ agent: 'investigator', tool: 'query_logs', args: { query_string: 'old' } });
    expect(m?.replay.map((s) => s.tool)).toEqual(['jira_create_issue']);
  });

  it('returns undefined when no procedure leads with the action tool', async () => {
    const lib = await loadedLib(spec());
    expect(await lib.match('meeting_interrupt')).toBeUndefined();
  });

  it('returns undefined on an empty library', async () => {
    const lib = new ProcedureLibrary({ episodic: new EpisodicMemory({}) });
    expect(await lib.match('query_logs')).toBeUndefined();
  });

  it('filters out procedures below the sample-size threshold', async () => {
    const s = spec({ sampleSize: 2 });
    const episodic = new EpisodicMemory({});
    await episodic.record('cross', { id: s.id, text: `procedure: ${s.trigger}`, metadata: { procedure: s } });
    const permissive = new ProcedureLibrary({ episodic, minSampleSize: 1 });
    const strict = new ProcedureLibrary({ episodic, minSampleSize: 3 });
    expect(await permissive.match('query_logs')).toBeDefined();
    expect(await strict.match('query_logs')).toBeUndefined();
  });

  it('prefers the highest-sample procedure among matches', async () => {
    const lib = await loadedLib(
      spec({ id: 'p-small', trigger: 'query_logs → a', sampleSize: 2, steps: [{ agent: 'investigator', tool: 'query_logs', args: {} }] }),
      spec({ id: 'p-big', trigger: 'query_logs → b', sampleSize: 9, steps: [{ agent: 'investigator', tool: 'query_logs', args: {} }] }),
    );
    expect((await lib.match('query_logs'))?.procedure.id).toBe('p-big');
  });

  it('refuses to load malformed procedure records (strict contract)', async () => {
    const episodic = new EpisodicMemory({});
    await episodic.record('cross', {
      id: 'junk',
      text: 'procedure: not really',
      metadata: { procedure: { id: 'junk', steps: 'nope' } },
    });
    const lib = new ProcedureLibrary({ episodic });
    await lib.refresh();
    expect(await lib.match('query_logs')).toBeUndefined();
    expect(lib.size()).toBe(0);
  });

  it('tolerates a throwing memory during refresh (stays empty, does not throw)', async () => {
    const lib = new ProcedureLibrary({
      episodic: {
        recall: async () => {
          throw new Error('memory backend down');
        },
      } as never,
    });
    await expect(lib.refresh()).resolves.toBeUndefined();
    expect(lib.size()).toBe(0);
  });

  it('refresh() picks up newly learned procedures', async () => {
    const episodic = new EpisodicMemory({});
    const lib = new ProcedureLibrary({ episodic });
    expect(await lib.match('query_logs')).toBeUndefined();
    await episodic.record('cross', {
      id: 'proc-new',
      text: 'procedure: query_logs → z',
      metadata: { procedure: spec({ id: 'proc-new', trigger: 'query_logs → z' }) },
    });
    const m = await lib.match('query_logs');
    expect(m?.procedure.id).toBe('proc-new');
  });
});

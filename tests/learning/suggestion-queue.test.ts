import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SuggestionQueue } from '../../src/learning/suggestion-queue';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sugg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const approvalOutcome = (i: number): string =>
  JSON.stringify({
    correlationId: `o${i}`,
    ts: i,
    toolCalls: [{ kind: 'tool_call', tool: 'execute_runbook_script', args: { script_name: 'restart-all' }, result: { ok: true, data: {} }, latencyMs: 5, attempts: 1 }],
    approvals: [{ correlationId: `o${i}`, ts: i, layer: 'governance', source: 'slack', kind: 'approval_granted', approvalId: `a${i}`, signerRole: 'admin' }],
  });

describe('SuggestionQueue', () => {
  it('emits a modify_rule suggestion when many destructive approvals are seen', async () => {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `o${i}.json`), approvalOutcome(i));
    }
    const q = new SuggestionQueue({ outcomesDir: dir, destructiveApprovalsThreshold: 3 });
    const out = await q.scan();
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.proposedChange.type).toBe('modify_rule');
    expect(out[0]?.evidence.sampleSize).toBe(5);
    expect(out[0]?.risk).toBe('high'); // relaxing human oversight is never low-risk
  });

  it('stays quiet below the threshold', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'o0.json'), approvalOutcome(0));
    const q = new SuggestionQueue({ outcomesDir: dir, destructiveApprovalsThreshold: 3 });
    expect(await q.scan()).toEqual([]);
  });

  it('ignores outcomes without approvals', async () => {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `p${i}.json`), JSON.stringify({ correlationId: `p${i}`, ts: i, toolCalls: [], approvals: [] }));
    }
    const q = new SuggestionQueue({ outcomesDir: dir, destructiveApprovalsThreshold: 3 });
    expect(await q.scan()).toEqual([]);
  });

  it('tolerates malformed outcome files', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{not json');
    writeFileSync(join(dir, 'good.json'), approvalOutcome(1));
    writeFileSync(join(dir, 'good2.json'), approvalOutcome(2));
    writeFileSync(join(dir, 'good3.json'), approvalOutcome(3));
    const q = new SuggestionQueue({ outcomesDir: dir, destructiveApprovalsThreshold: 3 });
    const out = await q.scan();
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence.outcomeIds.sort()).toEqual(['good', 'good2', 'good3'].sort());
  });
});

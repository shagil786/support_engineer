import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { correlationId } from '../../src/event-log/correlation';
import type { DecisionEvent } from '../../src/event-log/types';

describe('event-log e2e', () => {
  it('round-trips a realistic event sequence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventlog-e2e-'));
    try {
      const log = new JsonlFileEventLog({ baseDir: dir });
      const cid = correlationId(1_700_000_000_000);

      const sequence: DecisionEvent[] = [
        {
          correlationId: cid, ts: 1_700_000_000_000, layer: 'understanding', source: 'meeting',
          kind: 'understanding',
          envelope: { intent: { kind: 'meeting_response', subKind: 'question' }, confidence: 0.92, entities: { ticketKeys: ['SUPPORT-7'] }, rawContext: { source: 'meeting', ts: 1_700_000_000_000, payload: {} } },
          contextBundleRef: 'ctx-1',
        },
        {
          correlationId: cid, ts: 1_700_000_000_010, layer: 'governance', source: 'internal',
          kind: 'governance',
          intent: { intent: { kind: 'meeting_response', subKind: 'question' }, confidence: 0.92, entities: { ticketKeys: ['SUPPORT-7'] }, rawContext: { source: 'meeting', ts: 1_700_000_000_000, payload: {} } },
          decision: { effect: 'allow', reason: 'read-only Jira query', policyIds: ['read_only_default_allow'] },
        },
        {
          correlationId: cid, ts: 1_700_000_000_020, layer: 'execution', source: 'jira',
          kind: 'tool_call',
          tool: 'query_logs',
          args: { query_string: 'error payment-api' },
          result: { ok: true, data: { rows: [{ message: '500 on /checkout' }] } },
          latencyMs: 87, attempts: 1,
        },
      ];

      for (const e of sequence) await log.append(e);

      const got: DecisionEvent[] = [];
      for await (const e of log.query({ correlationId: cid })) got.push(e);

      expect(got).toHaveLength(3);
      expect(got.map((e) => e.kind)).toEqual(['understanding', 'governance', 'tool_call']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

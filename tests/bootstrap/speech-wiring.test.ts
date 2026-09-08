import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../../src/bootstrap';
import type { Platform } from '../../src/bootstrap';
import { anomalyToEnvelope } from '../../src/surface';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'speech-wiring-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bootstrap speech wiring', () => {
  it('meeting_interrupt speaks through deliverSpeech (the speak path is live, not dead)', async () => {
    const spoken: string[] = [];
    const p: Platform = createPlatform({
      dataDir: dir,
      deliverSpeech: (text) => spoken.push(text),
    });
    const env = anomalyToEnvelope({ severity: 'P1', summary: 'error rate spike on checkout', source: 'cloudwatch', ts: 1 });
    expect(env).toBeDefined();
    const r = await p.pipeline.processEnvelope(env!, { tool: 'meeting_interrupt', args: { message: 'P1: error rate spike on checkout' } });
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(true);
    expect(spoken.join(' ')).toContain('urgent alert');
  });

  it('a KB answer for a threaded utterance is ALSO replied in-thread via the Slack bot', async () => {
    const replies: Array<{ channel: string; ts: string; text: string }> = [];
    const spoken: string[] = [];
    const p: Platform = createPlatform({
      dataDir: dir,
      deliverSpeech: (text) => spoken.push(text),
      slackBot: {
        async postMessage(): Promise<void> {},
        async postReply(channel: string, ts: string, text: string): Promise<void> {
          replies.push({ channel, ts, text });
        },
      },
    });
    await p.knowledge.ingest({
      id: 'inc-42',
      text: 'Postmortem: the checkout timeout incident was caused by connection pool exhaustion.',
      metadata: { source: 'incidents' },
    });
    const r = await p.pipeline.processUtterance('U1', 'what caused the checkout incident?', 1_000, 'C-MEET', '1700000000.1');
    expect(r.answerSource).toBe('knowledge');
    expect(spoken.length).toBe(1);
    expect(replies).toEqual([{ channel: 'C-MEET', ts: '1700000000.1', text: spoken[0]! }]);
  });

  it('without a Slack bot, threaded answers still deliver via deliverSpeech (no crash, no reply)', async () => {
    const spoken: string[] = [];
    const p: Platform = createPlatform({
      dataDir: dir,
      deliverSpeech: (text) => spoken.push(text),
    });
    await p.knowledge.ingest({
      id: 'inc-42',
      text: 'Postmortem: the checkout timeout incident was caused by connection pool exhaustion.',
      metadata: { source: 'incidents' },
    });
    const r = await p.pipeline.processUtterance('U1', 'what caused the checkout incident?', 1_000, 'C-MEET', '1700000000.1');
    expect(r.answerSource).toBe('knowledge');
    expect(spoken.length).toBe(1);
  });
});

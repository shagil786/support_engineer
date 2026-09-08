import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createHttpServer, type HttpServerHandle } from '../../src/http/server';
import { createPlatform } from '../../src/bootstrap';
import type { Platform } from '../../src/bootstrap';

let dir: string;
const handles: HttpServerHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slack-e2e-'));
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = 'sec';
const TS = '1700000000';
const NOW = 1700000000 * 1000;
const signed = (body: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-slack-signature': 'v0=' + createHmac('sha256', SECRET).update('v0:' + TS + ':' + body).digest('hex'),
    'x-slack-timestamp': TS,
  },
  body,
});

describe('Slack meeting threads end to end', () => {
  it('utterances in a thread scope memory to the channel; approvals stage in-thread', async () => {
    const p: Platform = createPlatform({
      dataDir: dir,
      runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true }],
      speakerRole: (id) => (id === 'U-admin' ? 'admin' : undefined),
      now: () => NOW,
    });
    // Bot-token client fake: records where cards land.
    const cards: Array<{ channel: string; threadTs?: string }> = [];
    const h = await createHttpServer(p, {
      authTokens: ['tok-1'],
      slackSigningSecret: SECRET,
      now: () => NOW,
    });
    handles.push(h);

    // Swap in a fake SlackLike with thread support on the gate.
    const gate = p.approvals as unknown as { slack: Record<string, unknown> };
    gate.slack = {
      async postMessage(): Promise<void> {},
      async postRichThreadMessage(channel: string, threadTs: string): Promise<{ channel: string; ts: string }> {
        cards.push({ channel, threadTs });
        return { channel, ts: '1700000001.2' };
      },
      async updateRichMessage(): Promise<void> {},
      async updateMessage(): Promise<void> {},
      async postReply(): Promise<void> {},
    };

    // 1) Utterance in a Slack thread (message events carry thread_ts).
    const eventBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev-1',
      event: { type: 'message', text: 'agent, can you restart the checkout pod?', user: 'U-admin', ts: '1700000000.1', thread_ts: '1700000000.1', channel: 'C-MEET', event_ts: '1' },
    });
    const res = await fetch(h.url + '/slack/events', { method: 'POST', ...signed(eventBody) });
    expect(res.status).toBe(200);

    // 2) The utterance recorded under the CHANNEL meeting key, not the speaker's.
    const meetingsFile = join(dir, 'memory', 'meetings.json');
    expect(existsSync(meetingsFile)).toBe(true);
    const store = JSON.parse(readFileSync(meetingsFile, 'utf8')) as unknown;
    expect(JSON.stringify(store)).toContain('channel:C-MEET');

    // 3) The approval card was staged in-thread under the Slack message.
    expect(cards.length).toBe(1);
    expect(cards[0]!.channel).toBe('C-MEET');
    expect(cards[0]!.threadTs).toBe('1700000000.1');

    // 4) Scoped recall: a second utterance in the same thread sees thread context.
    const eventBody2 = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev-2',
      event: { type: 'message', text: 'what did you find in the logs for that?', user: 'U-admin', ts: '1700000002.1', thread_ts: '1700000000.1', channel: 'C-MEET', event_ts: '2' },
    });
    await fetch(h.url + '/slack/events', { method: 'POST', ...signed(eventBody2) });
    const store2 = JSON.parse(readFileSync(meetingsFile, 'utf8')) as Array<{ record: { metadata: Record<string, unknown> } }>;
    const channelRecords = store2.filter((e) => (e.record.metadata as { __meeting__?: { meetingId?: string } }).__meeting__?.meetingId === 'channel:C-MEET');
    expect(channelRecords.length).toBe(2);
  });
});

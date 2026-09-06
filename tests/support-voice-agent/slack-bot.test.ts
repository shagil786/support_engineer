import { describe, it, expect } from 'vitest';
import { SlackBotClient } from '../../src/support-voice-agent/integrations/slack-bot';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SlackBotClient', () => {
  it('posts via chat.postMessage with the bearer token and resolves the message ref', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new SlackBotClient({
      botToken: 'xoxb-test-token',
      request: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ ok: true, channel: 'C123', ts: '1700000000.000100' });
      },
    });
    const ref = await client.postMessageWithRef('#security', '*Approval needed*');

    expect(ref).toEqual({ channel: 'C123', ts: '1700000000.000100' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer xoxb-test-token');
  });

  it('satisfies the plain SlackLike port (postMessage delegates and discards the ref)', async () => {
    const client = new SlackBotClient({
      botToken: 'xoxb-test-token',
      request: async () => jsonResponse({ ok: true, channel: 'C123', ts: '1700000000.000100' }),
    });
    await expect(client.postMessage('#security', 'hello')).resolves.toBeUndefined();
  });

  it('throws with Slack API error names on non-ok responses', async () => {
    const client = new SlackBotClient({
      botToken: 'xoxb-test-token',
      request: async () => jsonResponse({ ok: false, error: 'channel_not_found' }),
    });
    await expect(client.postMessageWithRef('#missing', 'x')).rejects.toThrow(/channel_not_found/);
  });

  it('surfaces transport errors (wrong token → 401/invalid_auth shape)', async () => {
    const client = new SlackBotClient({
      botToken: 'xoxb-wrong',
      request: async () => jsonResponse({ ok: false, error: 'invalid_auth' }),
    });
    await expect(client.postMessageWithRef('#security', 'x')).rejects.toThrow(/invalid_auth/);
  });
});

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

  it('updates a message in place via chat.update', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const client = new SlackBotClient({
      botToken: 'xoxb-test-token',
      request: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return jsonResponse({ ok: true });
      },
    });
    await client.updateMessage('C123', '1700000000.000100', '*Approval GRANTED*');
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.update');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ channel: 'C123', ts: '1700000000.000100', text: '*Approval GRANTED*' });
  });

  it('posts threaded replies via chat.postMessage with thread_ts', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const client = new SlackBotClient({
      botToken: 'xoxb-test-token',
      request: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return jsonResponse({ ok: true });
      },
    });
    await client.postReply('C123', '1700000000.000100', 'Signatures: 1/2 — pending.');
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ channel: 'C123', thread_ts: '1700000000.000100', text: 'Signatures: 1/2 — pending.' });
  });

  it('posts rich cards with attachments and resolves the ref (postRichMessage)', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const client = new SlackBotClient({
      botToken: 'xoxb-test-token',
      request: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return jsonResponse({ ok: true, channel: 'C123', ts: '1700000000.000100' });
      },
    });
    const ref = await client.postRichMessage('#security', { text: 'fallback', attachments: [{ color: 'warning', blocks: [] }] });
    expect(ref).toEqual({ channel: 'C123', ts: '1700000000.000100' });
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    const body = JSON.parse(calls[0]?.body ?? '{}') as { attachments: unknown[]; text: string };
    expect(body.text).toBe('fallback');
    expect(body.attachments).toHaveLength(1);
  });

  it('re-renders cards in place via chat.update (updateRichMessage)', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const client = new SlackBotClient({
      botToken: 'xoxb-test-token',
      request: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return jsonResponse({ ok: true });
      },
    });
    await client.updateRichMessage('C123', '1700000000.000100', { text: 'granted', attachments: [{ color: 'good', blocks: [] }] });
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.update');
    const body = JSON.parse(calls[0]?.body ?? '{}') as { channel: string; ts: string; attachments: unknown[] };
    expect(body).toMatchObject({ channel: 'C123', ts: '1700000000.000100' });
    expect(body.attachments).toHaveLength(1);
  });
});

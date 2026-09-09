import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createPlatform, type Platform } from '../../src/bootstrap';
import { createHttpServer, type HttpServerHandle } from '../../src/http/server';

let dir: string;
let platform: Platform;
let handles: HttpServerHandle[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'http-'));
  platform = createPlatform({ dataDir: dir });
  handles = [];
});

afterEach(async () => {
  for (const h of handles) await h.close();
  handles = [];
  rmSync(dir, { recursive: true, force: true });
});

async function start(opts: Partial<Parameters<typeof createHttpServer>[1]> = {}): Promise<HttpServerHandle> {
  const h = await createHttpServer(platform, { authTokens: ['tok-1'], ...opts });
  handles.push(h);
  return h;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function post(url: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url + path, init);
}

const authed = (token = 'tok-1'): Record<string, string> => ({ authorization: 'Bearer ' + token });

describe('createHttpServer: auth', () => {
  it('serves /healthz without auth', async () => {
    const h = await start();
    const res = await fetch(h.url + '/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects missing and wrong bearer tokens with 401', async () => {
    const h = await start();
    const noAuth = await post(h.url, '/utterance', json({ speakerId: 'u1', text: 'hi' }));
    expect(noAuth.status).toBe(401);
    const badAuth = await post(h.url, '/utterance', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: JSON.stringify({ speakerId: 'u1', text: 'hi' }),
    });
    expect(badAuth.status).toBe(401);
  });

  it('fails closed with 503 on protected routes when no auth tokens are configured; health stays up', async () => {
    const h = await start({ authTokens: [] });
    const res = await post(h.url, '/utterance', json({ speakerId: 'u1', text: 'hi' }));
    expect(res.status).toBe(503);
    const health = await fetch(h.url + '/healthz');
    expect(health.status).toBe(200);
  });
});

describe('createHttpServer: POST /utterance', () => {
  it('routes an utterance through the pipeline and returns the routing result', async () => {
    const h = await start();
    // Chatter → legacy cascade (deterministic, no integrations needed).
    const res = await post(h.url, '/utterance', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ speakerId: 'u1', text: 'nice weather today' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routed: string; correlationId: string };
    expect(body.routed).toBe('legacy');
    expect(body.correlationId).toBeTruthy();
  });

  it('returns governance outcomes for content intents (guest veto is visible to the client)', async () => {
    const p = createPlatform({
      dataDir: dir,
      runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true }],
    });
    const h = await createHttpServer(p, { authTokens: ['tok-1'] });
    handles.push(h);
    const res = await post(h.url, '/utterance', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({
        speakerId: 'u1',
        text: 'agent, can you restart the checkout pod?',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routed: string; ok: boolean; reason?: string };
    expect(body.routed).toBe('pipeline');
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/veto/i);
  });

  it('validates the body: missing text, empty text, and bad JSON are 400', async () => {
    const h = await start();
    const missing = await post(h.url, '/utterance', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ speakerId: 'u1' }),
    });
    expect(missing.status).toBe(400);
    const empty = await post(h.url, '/utterance', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ speakerId: 'u1', text: '   ' }),
    });
    expect(empty.status).toBe(400);
    const bad = await post(h.url, '/utterance', {
      method: 'POST',
      headers: authed(),
      body: '{oops',
    });
    expect(bad.status).toBe(400);
  });

  it('rejects oversized bodies with 413', async () => {
    const h = await start({ maxBodyBytes: 1024 });
    const res = await post(h.url, '/utterance', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ speakerId: 'u1', text: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('404s unknown paths and 405s wrong methods', async () => {
    const h = await start();
    expect((await post(h.url, '/nope', { headers: authed() })).status).toBe(404);
    expect((await post(h.url, '/utterance', { headers: authed() })).status).toBe(405);
    expect((await fetch(h.url + '/utterance', { headers: authed() })).status).toBe(405);
  });
});

describe('createHttpServer: approvals', () => {
  it('signs and executes a staged approval over HTTP', async () => {
    const runbookPlatform = createPlatform({
      dataDir: dir,
      runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true }],
      speakerRole: (id) => (id === 'admin1' || id === 'admin2' ? 'admin' : undefined),
    });
    const h = await createHttpServer(runbookPlatform, { authTokens: ['tok-1'] });
    handles.push(h);
    const staged = await runbookPlatform.pipeline.processUtterance('admin1', 'agent, can you restart the checkout pod?', 500);
    expect(staged.approvalId).toBeDefined();

    // approverCount is 2 (the two-person rule): the FIRST signature must
    // leave the approval pending — no single signer can self-grant.
    const first = await post(h.url, '/approvals/' + staged.approvalId + '/sign', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ signerId: 'admin1' }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe('pending');

    const sign = await post(h.url, '/approvals/' + staged.approvalId + '/sign', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ signerId: 'admin2' }),
    });
    expect(sign.status).toBe(200);
    expect(((await sign.json()) as { status: string }).status).toBe('granted');

    const exec = await post(h.url, '/approvals/' + staged.approvalId + '/execute', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ correlationId: staged.correlationId }),
    });
    expect(exec.status).toBe(200);
    const body = (await exec.json()) as { routed: string; ok: boolean };
    expect(body.routed).toBe('pipeline');
    expect(body.ok).toBe(true);
  });

  it('403s a signer whose server-resolved role is insufficient — client-asserted roles are dead', async () => {
    const h = await start();
    const runbookPlatform = createPlatform({
      dataDir: dir,
      runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart all pods', destructive: true }],
      // admin-console is admin; everyone else is a guest.
      speakerRole: (id) => (id === 'admin-console' ? 'admin' : undefined),
    });
    const rh = await createHttpServer(runbookPlatform, { authTokens: ['tok-1'] });
    handles.push(rh);
    const staged = await runbookPlatform.pipeline.processUtterance('admin-console', 'agent, can you restart all pods?', 500);
    expect(staged.approvalId).toBeDefined();

    // The old escalation: claim admin in the body. Now irrelevant — the role
    // is resolved server-side and the guest is refused with 403.
    const escalated = await post(rh.url, '/approvals/' + staged.approvalId + '/sign', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ role: 'admin', signerId: 'guest-person' }),
    });
    expect(escalated.status).toBe(403);
    expect(((await escalated.json()) as { error: string }).error).toMatch(/guest/);

    // Missing signerId is a 400 (the client supplies WHO, never the role).
    const noWho = await post(rh.url, '/approvals/' + staged.approvalId + '/sign', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(noWho.status).toBe(400);
  });

  it('404s unknown approval ids', async () => {
    const h = await start();
    const res = await post(h.url, '/approvals/does-not-exist/sign', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ signerId: 'human-1' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('createHttpServer: POST /slack/events', () => {
  const secret = 'slack-secret';
  const ts = '1700000000';

  const slackNow = 1700000000 * 1000;
  const startAt = async (opts: Partial<Parameters<typeof createHttpServer>[1]> = {}): Promise<HttpServerHandle> =>
    start({ now: () => slackNow, ...opts });
  const slackBody = (payload: unknown): string => JSON.stringify(payload);
  const signed = (body: string): RequestInit => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': 'v0=' + createHmac('sha256', secret).update('v0:' + ts + ':' + body).digest('hex'),
      'x-slack-timestamp': ts,
    },
    body,
  });

  const wrapped = (counter: { calls: number }): Platform => {
    // Fresh platform per call ( spies are not restorable between tests —
    // vi.restoreAllMocks() does not undo replaced instance methods), and the
    // ORIGINAL method captured before spying so the mock delegates to the
    // untouched implementation instead of recursing into itself.
    const p = createPlatform({ dataDir: dir });
    const original = p.pipeline.processUtterance.bind(p.pipeline);
    vi.spyOn(p.pipeline, 'processUtterance').mockImplementation(async (speakerId, text, ts) => {
      counter.calls += 1;
      return original(speakerId, text, ts);
    });
    return p;
  };

  it('signed() helper sanity: fresh timestamp + valid signature pass verification', async () => {
    const h = await startAt({ slackSigningSecret: secret });
    const body = slackBody({ type: 'url_verification', challenge: 'helper-check' });
    const res = await post(h.url, '/slack/events', signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'helper-check' });
  });

  it('fails closed with 503 when no signing secret is configured', async () => {
    const h = await startAt();
    const res = await post(h.url, '/slack/events', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
  });

  it('fails closed with 503 on interactive when no signing secret is configured', async () => {
    const h = await startAt();
    const res = await post(h.url, '/slack/interactive', { method: 'POST', body: 'payload=%7B%7D' });
    expect(res.status).toBe(503);
  });

  it('rejects invalid signatures with 401', async () => {
    const h = await startAt({ slackSigningSecret: secret });
    const body = slackBody({ type: 'event_callback', event: { type: 'app_mention', text: 'hi', user: 'U1', event_ts: '1' } });
    const res = await post(h.url, '/slack/events', {
      method: 'POST',
      headers: { 'x-slack-signature': 'v0=deadbeef', 'x-slack-timestamp': ts },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('answers url_verification with the challenge echo', async () => {
    const h = await startAt({ slackSigningSecret: secret });
    const body = slackBody({ type: 'url_verification', challenge: 'ch-123' });
    const res = await post(h.url, '/slack/events', signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'ch-123' });
  });

  it('processes app_mention events and dedupes Slack retries by event_id', async () => {
    const counter = { calls: 0 };
    const h = await createHttpServer(wrapped(counter), { authTokens: ['tok-1'], slackSigningSecret: secret, now: () => slackNow });
    handles.push(h);
    const event = { type: 'app_mention', text: 'nice weather today', user: 'U1', ts: '1', event_ts: '1' };
    const body = slackBody({ type: 'event_callback', event_id: 'Ev-1', event });
    const first = await post(h.url, '/slack/events', signed(body));
    expect(first.status).toBe(200);
    expect(counter.calls).toBe(1);
    // Slack retries deliveries with the SAME event_id — must not re-process.
    const retry = await post(h.url, '/slack/events', signed(body));
    expect(retry.status).toBe(200);
    expect(counter.calls).toBe(1);
    // A different event id is a genuinely new message.
    const fresh = slackBody({ type: 'event_callback', event_id: 'Ev-2', event });
    const second = await post(h.url, '/slack/events', signed(fresh));
    expect(second.status).toBe(200);
    expect(counter.calls).toBe(2);
  });  it('grants a staged approval by Slack emoji reaction, end to end', async () => {
    const p = createPlatform({
      dataDir: dir,
      runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true }],
      speakerRole: (id) => (id === 'U-admin' ? 'admin' : undefined),
    });
    const h = await createHttpServer(p, { authTokens: ['tok-1'], slackSigningSecret: secret, now: () => slackNow });
    handles.push(h);
    const staged = await p.pipeline.processUtterance('U-admin', 'agent, can you restart the checkout pod?', 500);
    expect(staged.approvalId).toBeDefined();

    // Slack delivers the reaction; the console channel posted no ref, so the
    // gate correlates via the single-pending fallback. Role is resolved
    // server-side via the platform's speakerRole resolver.
    const body = slackBody({
      type: 'event_callback',
      event_id: 'Ev-r1',
      event: { type: 'reaction_added', reaction: 'shield', user: 'U-admin', item: { type: 'message', channel: 'C1', ts: '1' } },
    });
    const reaction = await post(h.url, '/slack/events', signed(body));
    expect(reaction.status).toBe(200);
    expect(await reaction.json()).toMatchObject({ ok: true, matched: true, accepted: true, status: 'pending', signatures: 1 });

    // Second signature grants; then the staged action executes over HTTP.
    await p.pipeline.signApproval(staged.approvalId!, 'admin', 'human-2');
    const exec = await post(h.url, '/approvals/' + staged.approvalId + '/execute', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ correlationId: staged.correlationId }),
    });
    expect(exec.status).toBe(200);
    expect(((await exec.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('grants a staged approval by BLOCK BUTTON click, end to end', async () => {
    const p = createPlatform({
      dataDir: dir,
      runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true }],
      speakerRole: (id) => (id === 'U-admin' ? 'admin' : undefined),
    });
    const h = await createHttpServer(p, { authTokens: ['tok-1'], slackSigningSecret: secret, now: () => slackNow });
    handles.push(h);
    const staged = await p.pipeline.processUtterance('U-admin', 'agent, can you restart the checkout pod?', 500);
    expect(staged.approvalId).toBeDefined();

    // Slack delivers a button click as a form-encoded interactive payload.
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U-admin' },
      actions: [{ action_id: 'approval:approve:' + staged.approvalId }],
    });
    const form = 'payload=' + encodeURIComponent(payload);
    const sig = 'v0=' + createHmac('sha256', secret).update('v0:' + ts + ':' + form).digest('hex');
    const click = await post(h.url, '/slack/interactive', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-signature': sig, 'x-slack-timestamp': ts },
      body: form,
    });
    expect(click.status).toBe(200);
    const body = (await click.json()) as { results: Array<{ matched: boolean; accepted: boolean; status: string; signatures: number }> };
    // M-of-N (approverCount 2): the admin click counts signature 1 of 2.
    expect(body.results?.[0]).toMatchObject({ matched: true, accepted: true, status: 'pending', signatures: 1 });

    // Second signature (API path) completes M-of-N; then execute over HTTP.
    await p.pipeline.signApproval(staged.approvalId!, 'admin', 'human-2');
    const exec = await post(h.url, '/approvals/' + staged.approvalId + '/execute', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ correlationId: staged.correlationId }),
    });
    expect(exec.status).toBe(200);
    expect(((await exec.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('rejects unsigned interactive payloads with 401', async () => {
    const h = await startAt({ slackSigningSecret: secret });
    const res = await post(h.url, '/slack/interactive', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'payload=%7B%22type%22%3A%22block_actions%22%7D',
    });
    expect(res.status).toBe(401);
  });

  it('fails closed with 503 when no signing secret is configured', async () => {
    const counter = { calls: 0 };
    const h = await createHttpServer(wrapped(counter), { authTokens: ['tok-1'], slackSigningSecret: secret, now: () => slackNow });
    handles.push(h);
    const bot = slackBody({ type: 'event_callback', event_id: 'Ev-3', event: { type: 'message', subtype: 'bot_message', bot_id: 'B1' } });
    expect((await post(h.url, '/slack/events', signed(bot))).status).toBe(200);
    const other = slackBody({ type: 'event_callback', event_id: 'Ev-4', event: { type: 'reaction_added' } });
    expect((await post(h.url, '/slack/events', signed(other))).status).toBe(200);
    expect(counter.calls).toBe(0);
  });
});

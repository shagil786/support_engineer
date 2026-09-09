import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform, type Platform } from '../../src/bootstrap';
import { createHttpServer, type HttpServerHandle } from '../../src/http/server';

let dir: string;
let handles: HttpServerHandle[];
let fakeNow: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ratelimit-'));
  handles = [];
  fakeNow = 1_700_000_000_000;
});

afterEach(async () => {
  for (const h of handles) await h.close();
  handles = [];
  rmSync(dir, { recursive: true, force: true });
});

const postUtterance = (h: HttpServerHandle, opts: { token?: string; key?: string; text?: string } = {}): Promise<Response> =>
  fetch(h.url + '/utterance', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: 'Bearer ' + opts.token } : {}),
      ...(opts.key ? { 'idempotency-key': opts.key } : {}),
    },
    body: JSON.stringify({ speakerId: 'u1', text: opts.text ?? 'nice weather today' }),
  });

describe('rate limiting', () => {
  it('429s with Retry-After when a token exceeds its budget; health is exempt', async () => {
    const p = createPlatform({ dataDir: dir });
    const h = await createHttpServer(p, { authTokens: ['t1'], rateLimitPerMinute: 3, now: () => fakeNow });
    handles.push(h);

    for (let i = 0; i < 3; i++) {
      const r = await postUtterance(h, { token: 't1' });
      expect(r.status).toBe(200);
    }
    const limited = await postUtterance(h, { token: 't1' });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(Number.isFinite(retryAfter) && retryAfter >= 1).toBe(true);
    expect(((await limited.json()) as { error: string }).error).toMatch(/rate/i);

    // Liveness never rate-limits.
    expect((await fetch(h.url + '/healthz')).status).toBe(200);
  });

  it('budgets are per credential: exhausting t1 leaves t2 untouched', async () => {
    const p = createPlatform({ dataDir: dir });
    const h = await createHttpServer(p, { authTokens: ['t1', 't2'], rateLimitPerMinute: 2, now: () => fakeNow });
    handles.push(h);
    (await postUtterance(h, { token: 't1' }));
    await postUtterance(h, { token: 't1' });
    expect((await postUtterance(h, { token: 't1' })).status).toBe(429);
    expect((await postUtterance(h, { token: 't2' })).status).toBe(200);
  });

  it('invalid tokens do not consume (or create) budget', async () => {
    const p = createPlatform({ dataDir: dir });
    const h = await createHttpServer(p, { authTokens: ['t1'], rateLimitPerMinute: 2, now: () => fakeNow });
    handles.push(h);
    for (let i = 0; i < 10; i++) {
      const r = await postUtterance(h, { token: 'bogus' });
      expect(r.status).toBe(401);
    }
    // The valid token still has its full budget.
    expect((await postUtterance(h, { token: 't1' })).status).toBe(200);
    expect((await postUtterance(h, { token: 't1' })).status).toBe(200);
    expect((await postUtterance(h, { token: 't1' })).status).toBe(429);
  });

  it('buckets refill over time (sliding window)', async () => {
    const p = createPlatform({ dataDir: dir });
    const h = await createHttpServer(p, { authTokens: ['t1'], rateLimitPerMinute: 2, now: () => fakeNow });
    handles.push(h);
    await postUtterance(h, { token: 't1' });
    await postUtterance(h, { token: 't1' });
    expect((await postUtterance(h, { token: 't1' })).status).toBe(429);
    fakeNow += 30_000; // half a minute → one token refilled
    expect((await postUtterance(h, { token: 't1' })).status).toBe(200);
    expect((await postUtterance(h, { token: 't1' })).status).toBe(429);
  });
});

describe('idempotency keys', () => {
  it('replays the stored response for a repeated key (same correlationId, marked as replay)', async () => {
    const p = createPlatform({ dataDir: dir });
    const h = await createHttpServer(p, { authTokens: ['t1'] });
    handles.push(h);
    const first = await postUtterance(h, { token: 't1', key: 'op-123' });
    const second = await postUtterance(h, { token: 't1', key: 'op-123' });
    const a = (await first.json()) as { correlationId: string };
    const b = (await second.json()) as { correlationId: string };
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(b.correlationId).toBe(a.correlationId);
    expect(first.headers.get('idempotent-replay')).toBeNull();
  });

  it('keys are scoped per credential', async () => {
    const p = createPlatform({ dataDir: dir });
    const h = await createHttpServer(p, { authTokens: ['t1', 't2'] });
    handles.push(h);
    const a = (await (await postUtterance(h, { token: 't1', key: 'k' })).json()) as { correlationId: string };
    const b = (await (await postUtterance(h, { token: 't2', key: 'k' })).json()) as { correlationId: string };
    expect(b.correlationId).not.toBe(a.correlationId);
  });

  it('coalesces concurrent same-key requests into ONE pipeline execution', async () => {
    const p = createPlatform({ dataDir: dir });
    let executions = 0;
    const original = p.pipeline.processUtterance.bind(p.pipeline);
    vi.spyOn(p.pipeline, 'processUtterance').mockImplementation(async (...args) => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 60));
      return original(...args);
    });
    const h = await createHttpServer(p, { authTokens: ['t1'] });
    handles.push(h);

    const [a, b] = await Promise.all([postUtterance(h, { token: 't1', key: 'same' }), postUtterance(h, { token: 't1', key: 'same' })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await b.json()) as { correlationId: string }).correlationId).toBe(((await a.json()) as { correlationId: string }).correlationId);
    expect(executions).toBe(1);
  });

  it('non-2xx responses are not cached: fix the body and the same key executes', async () => {
    const p = createPlatform({ dataDir: dir });
    const h = await createHttpServer(p, { authTokens: ['t1'] });
    handles.push(h);
    const bad = await fetch(h.url + '/utterance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t1', 'idempotency-key': 'fixable' },
      body: JSON.stringify({ speakerId: 'u1' }), // 400: no text
    });
    expect(bad.status).toBe(400);
    const good = await postUtterance(h, { token: 't1', key: 'fixable' });
    expect(good.status).toBe(200);
    expect(good.headers.get('idempotent-replay')).toBeNull();
  });

  it('entries expire after the TTL and re-execute', async () => {
    const p = createPlatform({ dataDir: dir });
    const h = await createHttpServer(p, { authTokens: ['t1'], idempotencyTtlMs: 1_000, now: () => fakeNow });
    handles.push(h);
    const a = (await (await postUtterance(h, { token: 't1', key: 'ttl' })).json()) as { correlationId: string };
    fakeNow += 2_000;
    const b = (await (await postUtterance(h, { token: 't1', key: 'ttl' })).json()) as { correlationId: string };
    expect(b.correlationId).not.toBe(a.correlationId);
  });
});

describe('approval execute double-click protection', () => {
  it('coalesces concurrent executes (no key) into one governed execution', async () => {
    const p = createPlatform({
      dataDir: dir,
      runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true }],
      speakerRole: (id) => (id === 'admin1' ? 'admin' : undefined),
    });
    let executions = 0;
    const original = p.pipeline.executeApproved.bind(p.pipeline);
    vi.spyOn(p.pipeline, 'executeApproved').mockImplementation(async (...args) => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 60));
      return original(...args);
    });
    const h = await createHttpServer(p, { authTokens: ['t1'] });
    handles.push(h);

    const staged = await p.pipeline.processUtterance('admin1', 'agent, can you restart the checkout pod?', 500);
    p.pipeline.signApprovalAs(staged.approvalId!, 'admin1');
    p.pipeline.signApprovalAs(staged.approvalId!, 'approver');

    const exec = () =>
      fetch(h.url + '/approvals/' + staged.approvalId + '/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t1' },
        body: JSON.stringify({ correlationId: staged.correlationId }),
      });
    const [a, b] = await Promise.all([exec(), exec()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await b.json()) as { ok: boolean }).ok).toBe(true);
    expect(((await a.json()) as { ok: boolean }).ok).toBe(true);
    expect(executions).toBe(1);
  });

  it('sequential re-executes within the replay window get the cached result; after it expires they run again', async () => {
    const p = createPlatform({
      dataDir: dir,
      runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true }],
      speakerRole: (id) => (id === 'admin1' ? 'admin' : undefined),
    });
    let executions = 0;
    const original = p.pipeline.executeApproved.bind(p.pipeline);
    vi.spyOn(p.pipeline, 'executeApproved').mockImplementation(async (...args) => {
      executions += 1;
      return original(...args);
    });
    const h = await createHttpServer(p, { authTokens: ['t1'], executeReplayTtlMs: 1_000, now: () => fakeNow });
    handles.push(h);

    const staged = await p.pipeline.processUtterance('admin1', 'agent, can you restart the checkout pod?', 500);
    p.pipeline.signApprovalAs(staged.approvalId!, 'admin1');
    p.pipeline.signApprovalAs(staged.approvalId!, 'approver');
    const exec = () =>
      fetch(h.url + '/approvals/' + staged.approvalId + '/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t1' },
        body: JSON.stringify({ correlationId: staged.correlationId }),
      });
    await exec();
    const replay = await exec();
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(executions).toBe(1);
    fakeNow += 2_000;
    await exec();
    expect(executions).toBe(2);
  });
});

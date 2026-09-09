import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform, type Platform } from '../../src/bootstrap';
import { createHttpServer, type HttpServerHandle } from '../../src/http/server';

let dir: string;
let platform: Platform;
let handles: HttpServerHandle[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'approvals-sse-'));
  platform = createPlatform({
    dataDir: dir,
    runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart all pods', destructive: true }],
    speakerRole: (id) => (id === 'admin-console' ? 'admin' : undefined),
  });
  handles = [];
});

afterEach(async () => {
  for (const h of handles) await h.close();
  handles = [];
  rmSync(dir, { recursive: true, force: true });
});

const authed = (token = 'tok-1'): Record<string, string> => ({ authorization: 'Bearer ' + token });

async function start(): Promise<HttpServerHandle> {
  const h = await createHttpServer(platform, { authTokens: ['tok-1'], sseKeepAliveMs: 30_000 });
  handles.push(h);
  return h;
}

/** Read SSE frames until `count` 'approvals' events arrive or the deadline
 *  passes. Returns the parsed approvals arrays in arrival order. */
async function readApprovalFrames(url: string, count: number, deadlineMs = 5_000): Promise<Array<Array<Record<string, unknown>>>> {
  const controller = new AbortController();
  const deadline = Date.now() + deadlineMs;
  const res = await fetch(url + '/approvals/events', { headers: { ...authed(), accept: 'text/event-stream' }, signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: Array<Array<Record<string, unknown>>> = [];
  try {
    while (frames.length < count && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), deadline - Date.now())),
      ]);
      if (chunk === 'timeout' || chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evLine = frame.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!evLine || evLine.slice(7) !== 'approvals' || !dataLine) continue;
        frames.push((JSON.parse(dataLine.slice(6)) as { approvals: Array<Record<string, unknown>> }).approvals);
      }
    }
  } finally {
    controller.abort();
  }
  return frames;
}

async function stageDestructive(url: string): Promise<{ approvalId: string; correlationId: string }> {
  const res = await fetch(url + '/utterance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed() },
    body: JSON.stringify({ speakerId: 'admin-console', text: 'hey agent, can you restart all pods?' }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { approvalId?: string; correlationId: string };
  expect(body.approvalId).toBeTruthy();
  return { approvalId: body.approvalId as string, correlationId: body.correlationId };
}

describe('GET /approvals/events (SSE queue stream)', () => {
  it('is fail-closed: 401 without a valid bearer token', async () => {
    const h = await start();
    const noAuth = await fetch(h.url + '/approvals/events');
    expect(noAuth.status).toBe(401);
    const bad = await fetch(h.url + '/approvals/events', { headers: authed('wrong') });
    expect(bad.status).toBe(401);
  });

  it('pushes the initial listing on connect (empty queue)', async () => {
    const h = await start();
    const frames = await readApprovalFrames(h.url, 1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual([]);
  });

  it('pushes a fresh listing after every queue mutation — no polling', async () => {
    const h = await start();
    const framesPromise = readApprovalFrames(h.url, 3);
    // Let the stream connect before staging.
    await new Promise((r) => setTimeout(r, 150));
    const staged = await stageDestructive(h.url);
    await fetch(h.url + `/approvals/${encodeURIComponent(staged.approvalId)}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authed() },
      body: JSON.stringify({ role: 'admin', signerId: 'approver-1' }),
    });
    const frames = await framesPromise;
    // 1: initial connect (empty) · 2: staged · 3: signature counted.
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual([]);
    expect(frames[1]).toHaveLength(1);
    expect(frames[1]?.[0]?.status).toBe('pending');
    expect(frames[1]?.[0]?.approvalId).toBe(staged.approvalId);
    expect(frames[2]).toHaveLength(1);
    expect(frames[2]?.[0]?.signatures).toBe(1);
    expect(frames[2]?.[0]?.status).toBe('pending'); // still needs the second signature
  });

  it('pushes the drain when the granted approval is executed', async () => {
    const h = await start();
    const framesPromise = readApprovalFrames(h.url, 5);
    await new Promise((r) => setTimeout(r, 150));
    const staged = await stageDestructive(h.url);
    for (const signer of ['approver-1', 'approver-2']) {
      await fetch(h.url + `/approvals/${encodeURIComponent(staged.approvalId)}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authed() },
        body: JSON.stringify({ role: 'admin', signerId: signer }),
      });
    }
    await fetch(h.url + `/approvals/${encodeURIComponent(staged.approvalId)}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authed() },
      body: JSON.stringify({ correlationId: staged.correlationId }),
    });
    const frames = await framesPromise;
    const statuses = frames.map((f) => (f.length ? (f[0]?.status as string) : 'empty'));
    // connect → staged(pending) → sig1(pending) → granted → executed(empty)
    expect(statuses).toEqual(['empty', 'pending', 'pending', 'granted', 'empty']);
  });

  it('emits keep-alive pings on the configured cadence', async () => {
    const h = await createHttpServer(platform, { authTokens: ['tok-1'], sseKeepAliveMs: 120 });
    handles.push(h);
    const controller = new AbortController();
    const res = await fetch(h.url + '/approvals/events', { headers: authed(), signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawPing = false;
    const deadline = Date.now() + 3_000;
    while (!sawPing && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      if (buf.includes('event: ping')) sawPing = true;
    }
    controller.abort();
    expect(sawPing).toBe(true);
  });
});

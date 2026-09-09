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
  dir = mkdtempSync(join(tmpdir(), 'console-'));
  platform = createPlatform({
    dataDir: dir,
    runbooks: [{ id: 'restart-all', name: 'restart-all', description: 'restart all pods', destructive: true }],
    // The console test's speaker is admin server-side; other ids stay guests.
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
  const h = await createHttpServer(platform, { authTokens: ['tok-1'] });
  handles.push(h);
  return h;
}

async function stageDestructive(url: string): Promise<{ approvalId: string; correlationId: string }> {
  const res = await fetch(url + '/utterance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed() },
    body: JSON.stringify({ speakerId: 'admin-console', text: 'hey agent, can you restart all pods?' }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { routed: string; approvalId?: string; correlationId: string };
  expect(body.routed).toBe('pipeline');
  expect(body.approvalId).toBeTruthy();
  return { approvalId: body.approvalId as string, correlationId: body.correlationId };
}

describe('GET /console (operator console shell)', () => {
  it('serves the static HTML shell WITHOUT bearer auth (it contains no data)', async () => {
    const h = await start();
    const res = await fetch(h.url + '/console');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Support Agent Console');
    expect(html).toContain('Approval queue');
    expect(html).toContain('speaker id');
    // The shell never embeds secrets or queue data — the JS fetches those.
    expect(html).not.toContain('tok-1');
  });

  it('is a 404-class neighbor: /consolex is not the shell', async () => {
    const h = await start();
    const res = await fetch(h.url + '/consolex');
    expect(res.status).toBe(401); // falls into the authed zone, no token → 401
  });
});

describe('GET /approvals (approval queue)', () => {
  it('is fail-closed: 401 without a valid bearer token', async () => {
    const h = await start();
    const noAuth = await fetch(h.url + '/approvals');
    expect(noAuth.status).toBe(401);
    const bad = await fetch(h.url + '/approvals', { headers: authed('wrong') });
    expect(bad.status).toBe(401);
  });

  it('returns an empty queue before anything is staged', async () => {
    const h = await start();
    const res = await fetch(h.url + '/approvals', { headers: authed() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvals: [] });
  });

  it('lists a staged approval with its tool, args, progress, and the staged correlationId', async () => {
    const h = await start();
    const staged = await stageDestructive(h.url);
    const res = await fetch(h.url + '/approvals', { headers: authed() });
    const { approvals } = (await res.json()) as {
      approvals: Array<{ approvalId: string; tool: string; args: Record<string, unknown>; signatures: number; required: number; correlationId?: string; reason: string; status: 'pending' | 'granted' }>;
    };
    expect(approvals).toHaveLength(1);
    const a = approvals[0];
    if (!a) throw new Error('expected one approval in the queue');
    expect(a.approvalId).toBe(staged.approvalId);
    expect(a.tool).toBe('execute_runbook_script');
    expect(a.args).toEqual({ script_name: 'restart-all' });
    expect(a.signatures).toBe(0);
    expect(a.required).toBe(2);
    expect(a.reason).toContain('destructive');
    expect(a.status).toBe('pending');
    // The execute-side correlation id, resolved server-side from the staged map.
    expect(a.correlationId).toBe(staged.correlationId);
  });

  it('keeps a granted-but-unexecuted approval in the queue with status granted', async () => {
    const h = await start();
    const staged = await stageDestructive(h.url);
    for (const signer of ['approver-1', 'approver-2']) {
      const r = await fetch(h.url + `/approvals/${encodeURIComponent(staged.approvalId)}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authed() },
        body: JSON.stringify({ role: 'admin', signerId: signer }),
      });
      expect(r.status).toBe(200);
    }
    const res = await fetch(h.url + '/approvals', { headers: authed() });
    const { approvals } = (await res.json()) as { approvals: Array<{ approvalId: string; status: string; signatures: number; correlationId?: string }> };
    expect(approvals).toHaveLength(1);
    const a = approvals[0];
    if (!a) throw new Error('expected the granted approval to remain listed');
    expect(a.approvalId).toBe(staged.approvalId);
    expect(a.status).toBe('granted');
    expect(a.signatures).toBe(2);
    // Still executable: the correlation id survives the grant.
    expect(a.correlationId).toBe(staged.correlationId);
  });

  it('drains the queue after the granted approval is executed', async () => {
    const h = await start();
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
    const res = await fetch(h.url + '/approvals', { headers: authed() });
    const { approvals } = (await res.json()) as { approvals: unknown[] };
    expect(approvals).toEqual([]); // executed → left the queue
  });
});

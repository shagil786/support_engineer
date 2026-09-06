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
  dir = mkdtempSync(join(tmpdir(), 'ask-'));
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

const post = async (url: string, path: string, body: unknown, token = 'tok-1'): Promise<Response> =>
  fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });

describe('POST /ask', () => {
  it('returns a cited answer from ingested knowledge', async () => {
    await platform.knowledge.ingest({
      id: 'run-restart',
      text: '# Restart the checkout pod\nUse this runbook when the checkout service stops responding.',
      metadata: { source: 'runbooks' },
    });
    const h = await start();
    const res = await post(h.url, '/ask', { question: 'checkout service stops responding' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; citations: number[]; refused: boolean; sources: Array<{ docId: string }> };
    expect(body.refused).toBe(false);
    expect(body.citations).toEqual([1]);
    expect(body.sources[0]?.docId).toBe('run-restart');
    expect(body.answer.toLowerCase()).toContain('checkout');
  });

  it('refuses honestly with 200 when nothing relevant is ingested', async () => {
    const h = await start();
    const res = await post(h.url, '/ask', { question: 'zzzqqq xyzzyx wumpus', topK: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refused: boolean; citations: number[]; sources: unknown[]; contextSize: number };
    expect(body.refused).toBe(true);
    expect(body.citations).toEqual([]);
    expect(body.sources).toEqual([]);
    expect(body.contextSize).toBe(0);
  });

  it('honors the where metadata filter', async () => {
    await platform.knowledge.ingest({ id: 'a', text: 'Checkout pod restart steps.', metadata: { source: 'runbooks' } });
    await platform.knowledge.ingest({ id: 'b', text: 'Checkout timeout incident.', metadata: { source: 'incidents' } });
    const h = await start();
    const res = await post(h.url, '/ask', { question: 'checkout', where: { source: 'incidents' } });
    const body = (await res.json()) as { sources: Array<{ source?: string }> };
    expect(body.sources.length).toBeGreaterThan(0);
    for (const s of body.sources) expect(s.source).toBe('incidents');
  });

  it('validates input and auth like every other route', async () => {
    const h = await start();
    expect((await post(h.url, '/ask', {}, 'wrong')).status).toBe(401);
    expect((await post(h.url, '/ask', {})).status).toBe(400);
    expect((await post(h.url, '/ask', { question: 'x', topK: 99 })).status).toBe(400);
    expect((await post(h.url, '/ask', { question: 'x', where: [1] })).status).toBe(400);
  });

  it('replays identically with the same Idempotency-Key', async () => {
    await platform.knowledge.ingest({ id: 'a', text: 'Checkout pod restart steps.', metadata: { source: 'runbooks' } });
    const h = await start();
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1', 'idempotency-key': 'ask-1' },
      body: JSON.stringify({ question: 'checkout' }),
    };
    const [r1, r2] = await Promise.all([fetch(h.url + '/ask', init), fetch(h.url + '/ask', init)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await r1.json()).toEqual(await r2.json());
  });
});

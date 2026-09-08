import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer, type HttpServerHandle } from '../../src/http/server';
import { createPlatform } from '../../src/bootstrap';

let dir: string;
const handles: HttpServerHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slack-thread-'));
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  rmSync(dir, { recursive: true, force: true });
});

const start = async (opts: Partial<Parameters<typeof createHttpServer>[1]> = {}): Promise<HttpServerHandle> => {
  const h = await createHttpServer(createPlatform({ dataDir: dir }), { authTokens: ['tok-1'], ...opts });
  handles.push(h);
  return h;
};

const post = async (url: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1' }, ...init });

describe('POST /utterance meeting channel targeting', () => {
  it('accepts an optional meetingChannel and forwards it to the pipeline', async () => {
    const h = await start();
    const res = await post(h.url, '/utterance', {
      body: JSON.stringify({ speakerId: 'U1', text: 'what caused the checkout incident?', meetingChannel: 'C123' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routed?: string };
    // Without an LLM the heuristic floor still classifies this as a question → pipeline.
    expect(body.routed).toBe('pipeline');
  });

  it('omitting meetingChannel keeps the existing shape working', async () => {
    const h = await start();
    const res = await post(h.url, '/utterance', {
      body: JSON.stringify({ speakerId: 'U1', text: 'hello there' }),
    });
    expect(res.status).toBe(200);
  });
});

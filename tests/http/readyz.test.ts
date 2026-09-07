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
  dir = mkdtempSync(join(tmpdir(), 'readyz-'));
  platform = createPlatform({ dataDir: dir });
  handles = [];
});

afterEach(async () => {
  for (const h of handles) await h.close();
  handles = [];
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /readyz: readiness with a real signal', () => {
  it('reports ready with platform details once boot work settles', async () => {
    const h = await createHttpServer(platform, { authTokens: ['tok'], ready: () => platform.ready() });
    handles.push(h);
    const res = await fetch(h.url + '/readyz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; learning: string; procedures: number; kb: { docs: number } };
    expect(body.ready).toBe(true);
    expect(body.learning).toBe('off');
    expect(body.procedures).toBe(0);
    expect(typeof body.kb.docs).toBe('number');
  });

  it('reports 503 not-ready while boot work is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await createHttpServer(platform, {
      authTokens: ['tok'],
      ready: async () => {
        await gate;
        return { learning: 'off', procedures: 0, kb: { docs: 0 } };
      },
    });
    handles.push(h);
    const pending = fetch(h.url + '/readyz');
    // Release after the probe's 250ms grace — the probe reports 503 while
    // the gate is still held.
    setTimeout(() => release(), 1000);
    const res = await pending;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(false);
  });

  it('stays unauthenticated and ready:true when no ready fn is wired (liveness parity)', async () => {
    const h = await createHttpServer(platform, { authTokens: ['tok'] });
    handles.push(h);
    const res = await fetch(h.url + '/readyz');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ready: boolean }).ready).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform, type Platform } from '../../src/bootstrap';
import { createHttpServer, type HttpServerHandle } from '../../src/http/server';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { ENVELOPE_SOURCES } from '../../src/surface/dispatch';

let dir: string;
let platform: Platform;
let handles: HttpServerHandle[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'envsrc-'));
  platform = createPlatform({ dataDir: dir });
  handles = [];
});

afterEach(async () => {
  for (const h of handles) await h.close();
  handles = [];
  rmSync(dir, { recursive: true, force: true });
});

const start = async (): Promise<HttpServerHandle> => {
  const h = await createHttpServer(platform, { authTokens: ['tok-1'] });
  handles.push(h);
  return h;
};

const post = (h: HttpServerHandle, body: unknown): Promise<Response> =>
  fetch(h.url + '/envelope', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1' },
    body: JSON.stringify(body),
  });

describe('POST /envelope: slack-mention and cron sources', () => {
  it('dispatches a Slack mention as an attributed async_triage question', async () => {
    const h = await start();
    const res = await post(h, { source: 'slack-mention', body: { text: 'what is the error rate?', user: 'U-alice' } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { accepted: boolean; routed?: string; correlationId?: string };
    expect(out.accepted).toBe(true);
    expect(out.routed).toBe('pipeline');
    // Attribution reached the decision trail: the speaker is the Slack user.
    let speaker: string | undefined;
    for await (const e of (platform.eventLog as JsonlFileEventLog).query({ correlationId: out.correlationId! })) {
      if (e.kind === 'governance') speaker = e.intent?.entities?.speakerId;
    }
    expect(speaker).toBe('U-alice');
  });

  it('drops malformed mention payloads (no text or no user) and enforces types', async () => {
    const h = await start();
    const noUser = await post(h, { source: 'slack-mention', body: { text: 'x' } });
    expect(((await noUser.json()) as { accepted: boolean }).accepted).toBe(false);
    const noText = await post(h, { source: 'slack-mention', body: { user: 'U1' } });
    expect(((await noText.json()) as { accepted: boolean }).accepted).toBe(false);
    const wrongTypes = await post(h, { source: 'slack-mention', body: { text: 5, user: false } });
    expect(((await wrongTypes.json()) as { accepted: boolean }).accepted).toBe(false);
  });

  it('dispatches a cron delivery with the scheduled job recorded', async () => {
    const h = await start();
    const res = await post(h, { source: 'cron', body: { scheduledJob: 'nightly-extraction' } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { accepted: boolean; routed?: string; correlationId?: string };
    expect(out.accepted).toBe(true);
    expect(out.routed).toBe('pipeline');
    let job: unknown;
    for await (const e of (platform.eventLog as JsonlFileEventLog).query({ correlationId: out.correlationId! })) {
      if (e.kind === 'governance') {
        job = (e.intent?.rawContext?.payload as { scheduledJob?: string } | undefined)?.scheduledJob;
      }
    }
    expect(job).toBe('nightly-extraction');
  });

  it('rejects cron deliveries without a job name', async () => {
    const h = await start();
    const res = await post(h, { source: 'cron', body: {} });
    expect(((await res.json()) as { accepted: boolean }).accepted).toBe(false);
    const wrongType = await post(h, { source: 'cron', body: { scheduledJob: 42 } });
    expect(((await wrongType.json()) as { accepted: boolean }).accepted).toBe(false);
  });

  it('still refuses caller-supplied proposals on the new sources', async () => {
    const h = await start();
    const res = await post(h, {
      source: 'slack-mention',
      body: { text: 'x', user: 'U1' },
      proposed: { tool: 'jira_create_issue', args: {} },
    });
    expect(res.status).toBe(400);
  });

  it('ENVELOPE_SOURCES documents every accepted source', () => {
    expect(ENVELOPE_SOURCES).toEqual(['jira', 'anomaly', 'slack-mention', 'cron']);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform, type Platform } from '../../src/bootstrap';
import { createHttpServer, type HttpServerHandle } from '../../src/http/server';
import { JsonlFileEventLog } from '../../src/event-log/log';

let dir: string;
let platform: Platform;
let handles: HttpServerHandle[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'envelope-'));
  platform = createPlatform({ dataDir: dir });
  handles = [];
});

afterEach(async () => {
  for (const h of handles) await h.close();
  handles = [];
  rmSync(dir, { recursive: true, force: true });
});

const startEnvelopeServer = async (): Promise<HttpServerHandle> => {
  const h = await createHttpServer(platform, { authTokens: ['tok-1'] });
  handles.push(h);
  return h;
};

const postEnvelope = (h: HttpServerHandle, body: unknown): Promise<Response> =>
  fetch(h.url + '/envelope', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1' },
    body: JSON.stringify(body),
  });

describe('POST /envelope: structured deliveries', () => {
  it('parses and dispatches a Jira webhook payload through governance', async () => {
    const h = await startEnvelopeServer();
    const res = await postEnvelope(h, {
      source: 'jira',
      body: { webhookEvent: 'jira:issue_created:issue', issue: { key: 'OPS-42' } },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { accepted: boolean; routed?: string; correlationId?: string; reason?: string };
    expect(out.accepted).toBe(true);
    expect(out.routed).toBe('pipeline');
    expect(out.correlationId).toBeTruthy();
    // The ENVELOPE (not just text) reached governance: the decision event
    // carries the parsed async_triage intent. The execution outcome here is
    // the platform's honest "log provider not wired" failure.
    let seen = false;
    for await (const e of (platform.eventLog as JsonlFileEventLog).query({ correlationId: out.correlationId! })) {
      if (e.kind === 'governance' && e.intent?.intent?.kind === 'async_triage') seen = true;
    }
    expect(seen).toBe(true);
  });

  it('parses and dispatches a monitoring anomaly (P1 → incident handling)', async () => {
    const h = await startEnvelopeServer();
    const res = await postEnvelope(h, {
      source: 'anomaly',
      body: { severity: 'P1', summary: 'latency spike on checkout', source: 'cloudwatch', ts: 1 },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { accepted: boolean; routed?: string };
    expect(out.accepted).toBe(true);
    expect(out.routed).toBe('pipeline');
  });

  it('drops payloads the parsers reject (wrong shape, bad severity, unknown source)', async () => {
    const h = await startEnvelopeServer();
    const badJira = await postEnvelope(h, { source: 'jira', body: { nope: true } });
    expect(((await badJira.json()) as { accepted: boolean }).accepted).toBe(false);

    const badSeverity = await postEnvelope(h, {
      source: 'anomaly',
      body: { severity: 'P99', summary: 'x', source: 'splunk', ts: 1 },
    });
    expect(((await badSeverity.json()) as { accepted: boolean }).accepted).toBe(false);

    const unknownSource = await postEnvelope(h, { source: 'github', body: {} });
    expect(unknownSource.status).toBe(400);
    const missingBody = await postEnvelope(h, { source: 'jira' });
    expect(missingBody.status).toBe(400);
  });

  it('rejects caller-supplied proposals (governance picks the action, not the client)', async () => {
    const h = await startEnvelopeServer();
    const res = await postEnvelope(h, {
      source: 'jira',
      body: { webhookEvent: 'x', issue: { key: 'OPS-1' } },
      proposed: { tool: 'jira_create_issue', args: { summary: 'injected' } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/proposed/i);
  });

  it('requires bearer auth like the other protected routes', async () => {
    const h = await startEnvelopeServer();
    const res = await fetch(h.url + '/envelope', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'jira', body: { webhookEvent: 'x', issue: { key: 'K' } } }),
    });
    expect(res.status).toBe(401);
  });
});

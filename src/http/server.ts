/**
 * HTTP surface for the platform (spec §3 surfaces) — the non-console entry
 * for API clients and Slack webhooks. Zero-dependency node:http.
 *
 *   POST /healthz                        liveness, no auth
 *   POST /utterance   {speakerId, text}  → PipelineRouting JSON
 *   POST /approvals/:id/sign             → ApprovalSnapshot
 *   POST /approvals/:id/execute          → PipelineRouting
 *   POST /slack/events                   Slack Events API (signed)
 *
 * Auth model, fail-closed by design:
 *  - /utterance + /approvals/*: bearer tokens. No tokens configured → 503,
 *    never an open surface.
 *  - /slack/events: Slack's v0 HMAC signature. No signing secret → 503.
 *    Slack deliveries are deduped by event_id (Slack retries aggressively).
 *
 * Handlers never throw: an exception inside the pipeline becomes a 500
 * envelope. Utterance responses carry the full PipelineRouting so callers
 * see vetoes, denials, staged approvals, and legacy fallbacks honestly.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Platform } from '../bootstrap.js';
import type { PipelineRouting } from '../pipeline/agent-pipeline.js';
import type { ApprovalSnapshot } from '../governance/approval-gate.js';
import type { IntentEnvelope } from '../event-log/types.js';
import type { ToolName } from '../support-voice-agent/tools/types.js';
import { buildEnvelope, ENVELOPE_SOURCES } from '../surface/dispatch.js';

export interface HttpServerOptions {
  /** Bearer tokens for /utterance and /approvals/*. Empty/missing → those
   *  routes return 503 (fail closed; the surface never opens unauthenticated). */
  authTokens?: string[];
  /** Slack signing secret for /slack/events. Missing → 503 on that route. */
  slackSigningSecret?: string;
  /** Body size cap in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  host?: string;
  port?: number;
  now?: () => number;
}

export interface HttpServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface Body {
  json: unknown;
  raw: string;
  error?: 'too-large';
}

/** The inner JSON of a Slack interactive-component POST's `payload` field. */
interface InteractivePayload {
  type?: string;
  user?: { id?: string };
  actions?: Array<{ action_id?: string }>;
}

const MAX_DEFAULT = 1024 * 1024;
/** Slack retry dedupe window: TTL-first, then a hard cap (a burst of
 *  unique events must not grow the map unbounded). */
const SLACK_DEDUPE_TTL_MS = 5 * 60_000;
const SLACK_DEDUPE_MAX = 5_000;

export async function createHttpServer(
  platform: Platform,
  opts: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  const maxBody = opts.maxBodyBytes ?? MAX_DEFAULT;
  const now = opts.now ?? Date.now;
  const tokens = new Set(opts.authTokens ?? []);
  const signingSecret = opts.slackSigningSecret;

  const seenSlackEvents = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      // Handler invariant: never throw past this point.
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      return reply(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/slack/events') return handleSlack(req, res);
    if (method === 'POST' && path === '/slack/interactive') return handleSlackInteractive(req, res);

    // Everything below requires a bearer token — fail closed when unconfigured.
    const token = bearer(req);
    if (tokens.size === 0) return reply(res, 503, { error: 'http auth not configured (set authTokens); refusing to serve unauthenticated' });
    if (!token || !hasToken(tokens, token)) return reply(res, 401, { error: 'invalid bearer token' });

    if (method === 'POST' && path === '/utterance') return handleUtterance(req, res);
    if (method === 'POST' && path === '/envelope') return handleEnvelope(req, res);

    const approval = /^\/approvals\/([^/]+)\/(sign|execute)$/.exec(path);
    if (method === 'POST' && approval && approval[1] && approval[2]) {
      // The regex's second group only matches 'sign' | 'execute'.
      return handleApproval(req, res, decodeURIComponent(approval[1]), approval[2] as 'sign' | 'execute');
    }

    const knownPath = path === '/utterance' || path === '/envelope' || approval !== null;
    if (method !== 'POST') {
      return reply(res, knownPath ? 405 : 404, knownPath ? { error: 'method not allowed' } : { error: 'not found' });
    }
    reply(res, 404, { error: 'not found' });
  }

  async function handleUtterance(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, maxBody);
    if (body.error === 'too-large') return reply(res, 413, { error: 'body too large' });
    const parsed = parseJson(body);
    if (!parsed.ok) return reply(res, 400, { error: parsed.error });

    const b = parsed.value as { speakerId?: unknown; text?: unknown; speakerRole?: unknown };
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (text.length === 0) return reply(res, 400, { error: 'text is required' });
    const speakerId = typeof b.speakerId === 'string' && b.speakerId.trim() !== '' ? b.speakerId : 'http-client';
    // Authorization is NOT a client assertion: roles resolve server-side from
    // the speakerId via the platform's SafetyNet resolver (unknown = guest).
    // Accepting a role from the request body would let any token holder
    // claim admin.

    try {
      const route = await platform.pipeline.processUtterance(speakerId, text, now());
      return reply(res, 200, route);
    } catch (e) {
      return reply(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** POST /envelope — structured deliveries (Jira webhooks, monitoring
   *  anomalies) dispatched through the same governance as utterances. The
   *  ACTION is chosen here by policy, never by the client: a caller-supplied
   *  `proposed` field is rejected outright. Untrusted payloads that fail
   *  their parser are dropped with `accepted: false`, not guessed. */
  async function handleEnvelope(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, maxBody);
    if (body.error === 'too-large') return reply(res, 413, { error: 'body too large' });
    const parsed = parseJson(body);
    if (!parsed.ok) return reply(res, 400, { error: parsed.error });
    const b = parsed.value as { source?: unknown; body?: unknown; proposed?: unknown };
    if (typeof b.source !== 'string' || !ENVELOPE_SOURCES.includes(b.source)) {
      return reply(res, 400, { error: `source must be one of: ${ENVELOPE_SOURCES.join(', ')}` });
    }
    if (b.body === undefined) return reply(res, 400, { error: 'body is required' });
    if (b.proposed !== undefined) {
      return reply(res, 400, { error: 'proposed actions are chosen by policy, not by the client' });
    }
    const envelope = buildEnvelope(b.source, b.body);
    if (!envelope) return reply(res, 200, { accepted: false, reason: 'payload rejected by the source parser' });
    const proposedAction = proposeFor(envelope);
    try {
      const route = await platform.pipeline.processEnvelope(envelope, proposedAction);
      return reply(res, 200, { accepted: true, ...route });
    } catch (e) {
      return reply(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleApproval(req: IncomingMessage, res: ServerResponse, approvalId: string, op: 'sign' | 'execute'): Promise<void> {
    const body = await readBody(req, maxBody);
    if (body.error === 'too-large') return reply(res, 413, { error: 'body too large' });
    const parsed = parseJson(body);
    if (!parsed.ok) return reply(res, 400, { error: parsed.error });

    try {
      if (op === 'sign') {
        const b = parsed.value as { role?: unknown; signerId?: unknown };
        if (typeof b.role !== 'string' || b.role.trim() === '') {
          return reply(res, 400, { error: 'role is required (admin | engineer | viewer | guest)' });
        }
        const snap: ApprovalSnapshot = platform.pipeline.signApproval(approvalId, b.role, typeof b.signerId === 'string' ? b.signerId : undefined);
        return reply(res, 200, snap);
      }
      const b = parsed.value as { correlationId?: unknown };
      if (typeof b.correlationId !== 'string' || b.correlationId.trim() === '') {
        return reply(res, 400, { error: 'correlationId is required (from the staged utterance response)' });
      }
      const route: PipelineRouting = await platform.pipeline.executeApproved(approvalId, b.correlationId);
      return reply(res, 200, route);
    } catch (e) {
      // Unknown approval ids and gate errors surface as 404/400-shaped 500s
      // with the reason — clients can distinguish by message.
      return reply(res, 404, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Slack interactive components (button clicks) arrive here as
   *  application/x-www-form-urlencoded with a `payload` field containing
   *  JSON. Signature is computed over the RAW body (the urlencoding must not
   *  be decoded before verification). */
  async function handleSlackInteractive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!signingSecret) {
      return reply(res, 503, { error: 'slack signing secret not configured; refusing to serve unverified interactions' });
    }
    const body = await readBody(req, maxBody);
    if (body.error === 'too-large') return reply(res, 413, { error: 'body too large' });
    const sig = header(req, 'x-slack-signature');
    const ts = header(req, 'x-slack-timestamp');
    if (!sig || !ts || !verifySlackSignature(signingSecret, sig, ts, body.raw, now)) {
      return reply(res, 401, { error: 'invalid slack signature' });
    }
    let payload: InteractivePayload | null = null;
    try {
      const params = new URLSearchParams(body.raw);
      payload = JSON.parse(params.get('payload') ?? 'null') as InteractivePayload | null;
    } catch {
      return reply(res, 400, { error: 'malformed interactive payload' });
    }
    if (!payload || payload.type !== 'block_actions') {
      return reply(res, 200, { ok: true, ignored: 'interaction type not handled' });
    }
    const userId = payload.user?.id ?? 'unknown';
    const results = [];
    for (const action of payload.actions ?? []) {
      if (!action.action_id) continue;
      results.push(
        await platform.approvals.handleAction({
          actionId: action.action_id,
          userId,
          userRole: userId !== 'unknown' ? platform.speakerRole(userId) : undefined,
        }),
      );
    }
    return reply(res, 200, { ok: true, results });
  }

  async function handleSlack(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!signingSecret) {
      return reply(res, 503, { error: 'slack signing secret not configured; refusing to serve unverified events' });
    }
    const body = await readBody(req, maxBody);
    if (body.error === 'too-large') return reply(res, 413, { error: 'body too large' });

    const sig = header(req, 'x-slack-signature');
    const ts = header(req, 'x-slack-timestamp');
    if (!sig || !ts || !verifySlackSignature(signingSecret, sig, ts, body.raw, now)) {
      return reply(res, 401, { error: 'invalid slack signature' });
    }

    const parsed = parseJson(body);
    if (!parsed.ok) return reply(res, 400, { error: parsed.error });
    const payload = parsed.value as {
      type?: string;
      challenge?: string;
      event_id?: string;
      event?: {
        type?: string;
        bot_id?: unknown;
        user?: string;
        text?: unknown;
        ts?: string;
        event_ts?: string;
        channel?: string;
        reaction?: string;
        item?: { type?: string; channel?: string; ts?: string };
      };
    };

    if (payload.type === 'url_verification') {
      return reply(res, 200, { challenge: typeof payload.challenge === 'string' ? payload.challenge : '' });
    }
    if (payload.type !== 'event_callback') return reply(res, 200, { ok: true, ignored: 'unknown payload type' });

    const event = payload.event;
    if (!event) return reply(res, 200, { ok: true, ignored: 'no event' });

    // Emoji sign-off: reaction events route to the ApprovalGate. The role is
    // resolved SERVER-SIDE from the Slack user id via the platform resolver
    // (unknown users are guests — a reaction is a claim, not a credential).
    if (event.type === 'reaction_added' || event.type === 'reaction_removed') {
      const reaction = typeof event.reaction === 'string' ? event.reaction : '';
      const result = await platform.approvals.handleReaction({
        type: event.type,
        reaction,
        userId: event.user ?? 'unknown',
        userRole: event.user ? platform.speakerRole(event.user) : undefined,
        ...(event.item?.channel ? { channel: event.item.channel } : {}),
        ...(event.item?.ts ? { ts: event.item.ts } : {}),
      });
      return reply(res, 200, { ok: true, ...result });
    }

    if (event.type !== 'app_mention' && event.type !== 'message') {
      return reply(res, 200, { ok: true, ignored: 'event type not handled' });
    }
    // Never respond to bots (including ourselves) — classic loop hazard.
    if (event.bot_id !== undefined) return reply(res, 200, { ok: true, ignored: 'bot-authored event' });
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (text === '') return reply(res, 200, { ok: true, ignored: 'empty text' });

    // Slack retries deliveries until acked; event_id dedupe makes that safe.
    if (payload.event_id !== undefined) {
      if (seenSlackEvents.has(payload.event_id)) {
        return reply(res, 200, { ok: true, deduped: true });
      }
      seenSlackEvents.set(payload.event_id, now());
      if (seenSlackEvents.size > SLACK_DEDUPE_MAX) pruneDedupe(seenSlackEvents, now());
    }

    const speaker = typeof event.user === 'string' && event.user !== '' ? event.user : 'slack-user';
    try {
      await platform.pipeline.processUtterance(speaker, text, now());
    } catch {
      // Already logged by the pipeline's own degradation; ack regardless so
      // Slack does not retry an event we cannot process.
    }
    return reply(res, 200, { ok: true });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/* ----------------------------- helpers ----------------------------- */

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The action policy will evaluate for a parsed envelope — chosen by the
 *  SERVER from the envelope's intent, never accepted from the client.
 *  Mirrors the pipeline's own question/meeting-interrupt defaults. */
function proposeFor(envelope: IntentEnvelope): { tool: ToolName; args: Record<string, unknown> } {
  if (envelope.intent.kind === 'async_triage') {
    return { tool: 'query_logs', args: { query_string: envelope.entities.ticketKeys?.[0] ?? 'errors' } };
  }
  if (envelope.intent.kind === 'proactive_alert') {
    const parts: string[] = [];
    if (envelope.entities.severity) parts.push(envelope.entities.severity);
    if (envelope.entities.services?.length) parts.push(envelope.entities.services.join(', '));
    return { tool: 'meeting_interrupt', args: { message: parts.length ? parts.join(' ') : 'proactive alert' } };
  }
  return { tool: 'meeting_interrupt', args: { message: 'surface delivery' } };
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? m[1] : undefined;
}

/** Constant-time membership check — token comparison must not leak timing. */
function hasToken(tokens: Set<string>, presented: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  for (const t of tokens) {
    const b = Buffer.from(t, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Slack v0 scheme: sig = HMAC-SHA256(secret, "v0:ts:body"), with a 5-minute
 *  replay window on the timestamp. */
function verifySlackSignature(secret: string, presented: string, ts: string, rawBody: string, now: () => number): boolean {
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now() / 1000 - tsNum) > 300) return false;
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let discarded = 0;
    // Oversize bodies are drained (discarded), not socket-killed: the client
    // gets a real 413 response. A hard cap stops unbounded abuse.
    const DISCARD_CAP = 64 * 1024 * 1024;
    req.on('data', (c: Buffer) => {
      if (tooLarge) {
        discarded += c.length;
        if (discarded > DISCARD_CAP) req.destroy();
        return;
      }
      size += c.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () =>
      resolve(tooLarge ? { json: undefined, raw: '', error: 'too-large' } : { json: undefined, raw: Buffer.concat(chunks).toString('utf8') }),
    );
    req.on('error', () => resolve({ json: undefined, raw: '' }));
    req.on('close', () => resolve({ json: undefined, raw: '' }));
  });
}

function parseJson(body: Body): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const v: unknown = JSON.parse(body.raw);
    return typeof v === 'object' && v !== null ? { ok: true, value: v } : { ok: false, error: 'body must be a JSON object' };
  } catch {
    return { ok: false, error: 'body is not valid JSON' };
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function pruneDedupe(map: Map<string, number>, nowMs: number): void {
  // TTL-first, then hard cap (a burst of unique events must not grow the map).
  for (const [id, seenAt] of map) {
    if (nowMs - seenAt > SLACK_DEDUPE_TTL_MS) map.delete(id);
  }
  const ids = [...map.entries()].sort((x, y) => x[1] - y[1]);
  while (ids.length > SLACK_DEDUPE_MAX) {
    const oldest = ids.shift();
    if (oldest) map.delete(oldest[0]);
  }
}

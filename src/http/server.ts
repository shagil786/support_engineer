/**
 * HTTP surface for the platform (spec §3 surfaces) — the non-console entry
 * for API clients and Slack webhooks. Zero-dependency node:http.
 *
 *   POST /healthz                        liveness, no auth
 *   POST /utterance   {speakerId, text}  → PipelineRouting JSON
 *   POST /ask         {question}         → grounded answer with citations
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
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Platform } from '../bootstrap.js';
import type { PipelineRouting } from '../pipeline/agent-pipeline.js';
import { SignerRoleError, type ApprovalSnapshot } from '../governance/approval-gate.js';
import type { IntentEnvelope } from '../event-log/types.js';
import type { ToolName } from '../support-voice-agent/tools/types.js';
import { buildEnvelope, ENVELOPE_SOURCES } from '../surface/dispatch.js';
import { renderMetrics } from './metrics.js';
import { createSlackHandlers } from './slack.js';

export interface HttpServerOptions {
  /** Bearer tokens for /utterance and /approvals/*. Empty/missing → those
   *  routes return 503 (fail closed; the surface never opens unauthenticated). */
  authTokens?: string[];
  /** Slack signing secret for /slack/events. Missing → 503 on that route. */
  slackSigningSecret?: string;
  /** Body size cap in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** Per-credential rate limit (requests/minute, token bucket). Default 120.
   *  Bearer routes key on the token, Slack routes on the source IP; /healthz
   *  and 401s are exempt. 429 responses carry Retry-After. */
  rateLimitPerMinute?: number;
  /** TTL for stored Idempotency-Key responses (default 24 h). */
  idempotencyTtlMs?: number;
  /** Replay window for auto-coalesced POST /approvals/:id/execute calls
   *  (default 5 min): inside it, a repeat execute gets the cached result
   *  instead of re-running the governed action. */
  executeReplayTtlMs?: number;
  /** Readiness probe backing GET /readyz: resolves with details when boot
   *  async work (KB indexing, store self-check) has settled. Absent = the
   *  server reports ready unconditionally (liveness parity). */
  ready?: () => Promise<Record<string, unknown>>;
  host?: string;
  port?: number;
  now?: () => number;
  /** SSE keep-alive cadence for /approvals/events (default 15 s). */
  sseKeepAliveMs?: number;
}

export interface HttpServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** A stored idempotent response: status, JSON body, and header markers. */
interface CachedResponse {
  status: number;
  body: unknown;
  createdAt: number;
}

/** In-flight request still executing for an idempotency key. */
interface InFlight {
  promise: Promise<CachedResponse>;
  createdAt: number;
}

interface Body {
  json: unknown;
  raw: string;
  error?: 'too-large';
}

const MAX_DEFAULT = 1024 * 1024;
const DEFAULT_RATE_LIMIT_PER_MIN = 120;
/** SSE keep-alive cadence: frequent enough to hold open idling proxies, rare
 *  enough to be invisible in logs. */
const SSE_KEEP_ALIVE_MS = 15_000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_EXECUTE_REPLAY_TTL_MS = 5 * 60_000;
/** Idempotency caches never grow unbounded: TTL sweep + hard cap. */
const IDEMPOTENCY_MAX_ENTRIES = 10_000;
export async function createHttpServer(
  platform: Platform,
  opts: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  const maxBody = opts.maxBodyBytes ?? MAX_DEFAULT;
  const now = opts.now ?? Date.now;
  const tokens = new Set(opts.authTokens ?? []);
  const signingSecret = opts.slackSigningSecret;

  const seenSlackEvents = new Map<string, number>();
  // Slack webhook handlers live in ./slack.ts (HMAC verification, Events API
  // routing, interactive clicks). This closure owns the dedupe map they use.
  const slack = createSlackHandlers({ platform, signingSecret, maxBody, now, reply, readBody, seenSlackEvents });

  // ---- Rate limiting: per-credential token buckets. Bearer routes key on
  // the VALIDATED token (invalid tokens never mint a bucket); Slack routes
  // key on the source IP; /healthz is exempt. Refill is continuous.
  const rateLimit = opts.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MIN;
  const idemTtl = opts.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const execReplayTtl = opts.executeReplayTtlMs ?? DEFAULT_EXECUTE_REPLAY_TTL_MS;
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  // ---- Idempotency: replay for client keys on dispatch routes + auto
  // coalescing on approval execute (two rapid button/API clicks must not
  // run the governed action twice).
  const idemResponses = new Map<string, CachedResponse>();
  const idemInFlight = new Map<string, InFlight>();
  /** Route context: which credential a request authenticated as (for
   *  rate-limit keying and idempotency scoping), set after auth passes. */
  const routeContexts = new WeakMap<ServerResponse, { credential: string }>();
  /** Bodies peeked during auto-keying, handed to the handler's readBody. */
  const peekedBodies = new WeakMap<IncomingMessage, string>();

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

    // Operator console: a static single-page shell served WITHOUT the bearer
    // token (it contains no data); the page's JS then authenticates to the
    // same JSON surface as any API client and stores its token in
    // sessionStorage. The token is therefore never sent to a third party and
    // never rendered anywhere but in the credential input.
    if (method === 'GET' && path === '/console') {
      return reply(res, 200, CONSOLE_HTML, 'text/html; charset=utf-8');
    }

    // Readiness: unauthenticated like /healthz, but honest — 503 while boot
    // async work is pending, 200 with platform details once settled. The
    // probe FAILS FAST: awaiting a pending ready() would hang the LB probe,
    // so the pending promise is raced against a sentinel; the promise keeps
    // running and later probes see it settled.
    if (method === 'GET' && path === '/readyz') {
      if (!opts.ready) return reply(res, 200, { ready: true });
      const PENDING = Symbol('pending');
      // 250ms grace: normal boot work (KB re-embed, self-check) settles in
      // milliseconds, so first probes succeed; a genuinely stuck boot reports
      // 503 fast instead of hanging the LB's probe.
      const raced = await Promise.race([
        opts.ready().then(
          (d) => ({ ok: true as const, details: d }),
          (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
        ),
        new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), 250)),
      ]);
      if (raced === PENDING) return reply(res, 503, { ready: false });
      if (!raced.ok) return reply(res, 503, { ready: false, error: raced.error });
      return reply(res, 200, { ready: true, ...raced.details });
    }

    // Slack routes: rate-limited by source IP (the credential IS the HMAC).
    if (method === 'POST' && path === '/slack/events') {
      if (limitClient(`ip:${clientKey(req)}`)) return tooMany(res);
      return handleSlack(req, res);
    }
    if (method === 'POST' && path === '/slack/interactive') {
      if (limitClient(`ip:${clientKey(req)}`)) return tooMany(res);
      return handleSlackInteractive(req, res);
    }

    // Everything below requires a bearer token — fail closed when unconfigured.
    const token = bearer(req);
    if (tokens.size === 0) return reply(res, 503, { error: 'http auth not configured (set authTokens); refusing to serve unauthenticated' });
    if (!token || !hasToken(tokens, token)) return reply(res, 401, { error: 'invalid bearer token' });
    // Only VALID tokens consume budget — a 401 flood cannot mint buckets.
    routeContexts.set(res, { credential: token });
    if (limitClient('token:' + token)) return tooMany(res);

    if (method === 'GET' && path === '/approvals') {
      const approvals = platform.pipeline.listPendingApprovals().map((a) => ({
        ...a,
        // The correlation id executeApproved needs, resolved server-side from
        // the staged map — the client never assembles one.
        correlationId: platform.pipeline.stagedCorrelation(a.approvalId),
      }));
      return reply(res, 200, { approvals });
    }

    // Server-sent events: live approval-queue updates for the console. Same
    // auth wall and rate budget as every route below (one connect consumes
    // one request's budget; reconnect storms are throttled like any flood).
    // The stream pushes the full listing on connect and after every queue
    // mutation — the payload is the SAME shape as GET /approvals, so client
    // and server can never disagree about the queue's schema.
    if (method === 'GET' && path === '/approvals/events') {
      return streamApprovals(req, res);
    }

    if (method === 'GET' && path === '/metrics') {
      const metrics = await renderMetrics(platform.eventLog);
      return reply(res, 200, metrics, 'text/plain; version=0.0.4');
    }

    if (method === 'POST' && path === '/utterance') {
      return dispatchIdempotent(req, res, 'utterance', () => handleUtterance(req, res));
    }
    if (method === 'POST' && path === '/envelope') {
      return dispatchIdempotent(req, res, 'envelope', () => handleEnvelope(req, res));
    }
    if (method === 'POST' && path === '/ask') {
      return dispatchIdempotent(req, res, 'ask', () => handleAsk(req, res));
    }

    const approval = /^\/approvals\/([^/]+)\/(sign|execute)$/.exec(path);
    if (method === 'POST' && approval && approval[1] && approval[2]) {
      // The regex's second group only matches 'sign' | 'execute'.
      const op = approval[2] as 'sign' | 'execute';
      const approvalId = decodeURIComponent(approval[1]);
      if (op === 'execute') {
        // Auto-coalescing: concurrent/rapid re-executes share one governed
        // run inside the replay window — with or without a client key.
        return dispatchIdempotent(req, res, `execute:${approvalId}`, () => handleApproval(req, res, approvalId, op), {
          autoKey: true,
          ttl: execReplayTtl,
        });
      }
      return dispatchIdempotent(req, res, `sign:${approvalId}`, () => handleApproval(req, res, approvalId, op));
    }

    const knownPath = path === '/utterance' || path === '/envelope' || path === '/ask' || approval !== null;
    if (method !== 'POST') {
      return reply(res, knownPath ? 405 : 404, knownPath ? { error: 'method not allowed' } : { error: 'not found' });
    }
    reply(res, 404, { error: 'not found' });
  }

  /** SSE stream of approval-queue state (GET /approvals/events). Pushes the
   *  full listing on connect and after every gate mutation — the payload is
   *  the SAME shape as GET /approvals, so client and server can never
   *  disagree about the queue's schema. Keep-alive pings keep proxies from
   *  idling the connection out; the subscription is released on disconnect. */
  function streamApprovals(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Defeat proxy buffering (nginx et al.) so events arrive immediately.
      'x-accel-buffering': 'no',
    });
    let closed = false;
    const send = (event: string, data: unknown): void => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const push = (): void => {
      const approvals = platform.pipeline.listPendingApprovals().map((a) => ({
        ...a,
        correlationId: platform.pipeline.stagedCorrelation(a.approvalId),
      }));
      send('approvals', { approvals });
    };
    push();
    const unsubscribe = platform.pipeline.onApprovalQueueChange(push);
    const keepAlive = setInterval(() => send('ping', { ts: now() }), opts.sseKeepAliveMs ?? SSE_KEEP_ALIVE_MS);
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    };
    req.on('close', finish);
    res.on('close', finish);
    res.on('error', finish);
  }

  async function handleUtterance(req: IncomingMessage, res: ServerResponse): Promise<CachedResponse> {
    const body = await readBody(req, maxBody);
    if (body.error === 'too-large') return { status: 413, body: { error: 'body too large' }, createdAt: now() };
    const parsed = parseJson(body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error }, createdAt: now() };

    const b = parsed.value as { speakerId?: unknown; text?: unknown; speakerRole?: unknown; meetingChannel?: unknown };
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (text.length === 0) return { status: 400, body: { error: 'text is required' }, createdAt: now() };
    const speakerId = typeof b.speakerId === 'string' && b.speakerId.trim() !== '' ? b.speakerId : 'http-client';
    // Optional meeting channel: Slack thread targeting. Scope memory + approval
    // staging to this conversation instead of the speaker's global one.
    const meetingChannel = typeof b.meetingChannel === 'string' && b.meetingChannel.trim() !== '' ? b.meetingChannel.trim() : undefined;
    // Authorization is NOT a client assertion: roles resolve server-side from
    // the speakerId via the platform's SafetyNet resolver (unknown = guest).
    // Accepting a role from the request body would let any token holder
    // claim admin.

    try {
      const route = await platform.pipeline.processUtterance(speakerId, text, now(), meetingChannel);
      return { status: 200, body: route, createdAt: now() };
    } catch (e) {
      return { status: 500, body: { error: e instanceof Error ? e.message : String(e) }, createdAt: now() };
    }
  }

  /** POST /envelope — structured deliveries (Jira webhooks, monitoring
   *  anomalies) dispatched through the same governance as utterances. The
   *  ACTION is chosen here by policy, never by the client: a caller-supplied
   *  `proposed` field is rejected outright. Untrusted payloads that fail
   *  their parser are dropped with `accepted: false`, not guessed. */
  /** POST /ask — grounded Q&A over the knowledge base. Read-only by
   *  construction: retrieval + the GroundedAnswerer never call tools or
   *  governance. Refusals are 200 (an honest answer, not an error). */
  async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<CachedResponse> {
    void res;
    const body = await readBody(req, maxBody, peekedBodies.get(req));
    if (body.error === 'too-large') return { status: 413, body: { error: 'body too large' }, createdAt: now() };
    const parsed = parseJson(body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error }, createdAt: now() };
    const b = parsed.value as { question?: unknown; topK?: unknown; where?: unknown };
    if (typeof b.question !== 'string' || b.question.trim().length === 0) {
      return { status: 400, body: { error: 'question is required' }, createdAt: now() };
    }
    if (b.topK !== undefined && (typeof b.topK !== 'number' || !Number.isInteger(b.topK) || b.topK < 1 || b.topK > 10)) {
      return { status: 400, body: { error: 'topK must be an integer in [1, 10]' }, createdAt: now() };
    }
    if (b.where !== undefined && (typeof b.where !== 'object' || b.where === null || Array.isArray(b.where))) {
      return { status: 400, body: { error: 'where must be an object of metadata filters' }, createdAt: now() };
    }
    const answer = await platform.answerer.answer(b.question.trim(), {
      ...(typeof b.topK === 'number' ? { topK: b.topK } : {}),
      ...(b.where !== undefined ? { where: b.where as { source?: string; tags?: string[] } } : {}),
    });
    return { status: 200, body: answer, createdAt: now() };
  }

  async function handleEnvelope(req: IncomingMessage, res: ServerResponse): Promise<CachedResponse> {
    const body = await readBody(req, maxBody, peekedBodies.get(req));
    if (body.error === 'too-large') return { status: 413, body: { error: 'body too large' }, createdAt: now() };
    const parsed = parseJson(body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error }, createdAt: now() };
    const b = parsed.value as { source?: unknown; body?: unknown; proposed?: unknown };
    if (typeof b.source !== 'string' || !ENVELOPE_SOURCES.includes(b.source)) {
      return { status: 400, body: { error: `source must be one of: ${ENVELOPE_SOURCES.join(', ')}` }, createdAt: now() };
    }
    if (b.body === undefined) return { status: 400, body: { error: 'body is required' }, createdAt: now() };
    if (b.proposed !== undefined) {
      return { status: 400, body: { error: 'proposed actions are chosen by policy, not by the client' }, createdAt: now() };
    }
    const envelope = buildEnvelope(b.source, b.body);
    if (!envelope) return { status: 200, body: { accepted: false, reason: 'payload rejected by the source parser' }, createdAt: now() };
    const proposedAction = proposeFor(envelope);
    try {
      const route = await platform.pipeline.processEnvelope(envelope, proposedAction);
      return { status: 200, body: { accepted: true, ...route }, createdAt: now() };
    } catch (e) {
      return { status: 500, body: { error: e instanceof Error ? e.message : String(e) }, createdAt: now() };
    }
  }

  async function handleApproval(req: IncomingMessage, res: ServerResponse, approvalId: string, op: 'sign' | 'execute'): Promise<CachedResponse> {
    // The execute route may have peeked the body during auto-keying; reuse it.
    const body = await readBody(req, maxBody, peekedBodies.get(req));
    if (body.error === 'too-large') return { status: 413, body: { error: 'body too large' }, createdAt: now() };
    const parsed = parseJson(body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error }, createdAt: now() };

    try {
      if (op === 'sign') {
        // Identity contract: the client supplies WHO (signerId); the platform
        // resolves WHAT THAT IS WORTH via the same speaker registry the
        // SafetyNet uses. A client-asserted role is never accepted.
        const b = parsed.value as { signerId?: unknown };
        if (typeof b.signerId !== 'string' || b.signerId.trim() === '') {
          return { status: 400, body: { error: 'signerId is required (the server resolves its role)' }, createdAt: now() };
        }
        const snap: ApprovalSnapshot = platform.pipeline.signApprovalAs(approvalId, b.signerId);
        return { status: 200, body: snap, createdAt: now() };
      }
      const b = parsed.value as { correlationId?: unknown };
      if (typeof b.correlationId !== 'string' || b.correlationId.trim() === '') {
        return { status: 400, body: { error: 'correlationId is required (from the staged utterance response)' }, createdAt: now() };
      }
      const route: PipelineRouting = await platform.pipeline.executeApproved(approvalId, b.correlationId);
      return { status: 200, body: route, createdAt: now() };
    } catch (e) {
      // Unknown approval ids surface as 404s with the reason; an insufficient
      // resolved role is 403 (authenticated but not allowed) — never folded
      // into 404, which would hide the privilege failure.
      if (e instanceof SignerRoleError) {
        return { status: 403, body: { error: e.message }, createdAt: now() };
      }
      return { status: 404, body: { error: e instanceof Error ? e.message : String(e) }, createdAt: now() };
    }
  }

  const { handleSlack, handleSlackInteractive } = slack;

/* ------------------- rate limiting + idempotency ------------------- */

/** Consume one token from the credential's bucket; false when exhausted. */
function limitClient(credential: string): boolean {
  const t = now();
  const capacity = rateLimit;
  const refillPerMs = capacity / 60_000;
  let b = buckets.get(credential);
  if (!b) {
    b = { tokens: capacity, updatedAt: t };
    buckets.set(credential, b);
  }
  b.tokens = Math.min(capacity, b.tokens + (t - b.updatedAt) * refillPerMs);
  b.updatedAt = t;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  if (buckets.size > IDEMPOTENCY_MAX_ENTRIES) {
    for (const [k, bb] of buckets) {
      if (t - bb.updatedAt > 60_000) buckets.delete(k);
    }
  }
  return false;
}

function tooMany(res: ServerResponse): void {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
  res.end(JSON.stringify({ error: 'rate limit exceeded; slow down' }));
}

function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown-ip';
}

/** Idempotent dispatch: replay a stored 2xx for the same (credential, key),
 *  coalesce concurrent same-key requests into one execution, store the
 *  result when settled (2xx only — a failed attempt can be retried with the
 *  same key). Keys are opt-in via the Idempotency-Key header except on
 *  approval execute, where the route auto-scopes by credential+path+body so
 *  double-clicks cannot double-execute a governed action. */
async function dispatchIdempotent(
  req: IncomingMessage,
  res: ServerResponse,
  routeScope: string,
  run: () => Promise<CachedResponse>,
  o: { autoKey?: boolean; ttl?: number } = {},
): Promise<void> {
  const credential = routeContexts.get(res)?.credential ?? 'unknown';
  const ttl = o.ttl ?? idemTtl;
  const clientKeyHeader = header(req, 'idempotency-key');
  let key: string | undefined = clientKeyHeader?.trim() || undefined;
  if (!key && o.autoKey) {
    // Best-effort body signature so the same action executed twice with an
    // identical body coalesces; differing bodies are distinct operations.
    const raw = await peekBody(req);
    key = 'auto:' + createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }
  if (!key) {
    const r = await run();
    return sendCached(res, r);
  }
  const scoped = `${credential}:${routeScope}:${key}`;
  const stored = idemResponses.get(scoped);
  if (stored && now() - stored.createdAt <= ttl) {
    return sendCached(res, stored, true);
  }
  if (stored) idemResponses.delete(scoped);
  const inflight = idemInFlight.get(scoped);
  if (inflight) {
    const shared = await inflight.promise;
    return sendCached(res, shared, true);
  }
  const p = run()
    .then((r) => {
      if (r.status >= 200 && r.status < 300) {
        idemResponses.set(scoped, r);
        if (idemResponses.size > IDEMPOTENCY_MAX_ENTRIES) {
          for (const [k, v] of idemResponses) {
            if (now() - v.createdAt > idemTtl) idemResponses.delete(k);
          }
        }
      }
      return r;
    })
    .finally(() => idemInFlight.delete(scoped));
  idemInFlight.set(scoped, { promise: p, createdAt: now() });
  const r = await p;
  sendCached(res, r);
}

function sendCached(res: ServerResponse, r: CachedResponse, replay = false): void {
  void res.writeHead(r.status, {
    'content-type': 'application/json',
    ...(replay ? { 'idempotent-replay': 'true' } : {}),
  });
  res.end(JSON.stringify(r.body));
}  /** Body peek for auto-keying: reads the stream ONCE and caches the raw
   *  body on the request, so the handler's readBody finds it already there
   *  (a consumed stream would hang readBody forever). */
  async function peekBody(req: IncomingMessage): Promise<string> {
    const cached = peekedBodies.get(req);
    if (cached !== undefined) return cached;
    const raw = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
    peekedBodies.set(req, raw);
    return raw;
  }

/** The action policy will evaluate for a parsed envelope — chosen by the
 *  SERVER from the envelope's intent, never accepted from the client.
 *  Mirrors the pipeline's own question/meeting-interrupt defaults. */
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

/** The operator console shell (served at GET /console). Loaded once from
 *  src/http/console.html at module init — the file ships in the repo, and
 *  containers copy the full tree, so the read cannot fail at runtime. */
const CONSOLE_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'console.html'), 'utf8');

function reply(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

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

function readBody(req: IncomingMessage, maxBytes: number, preRead?: string): Promise<Body> {
  if (preRead !== undefined) {
    return Promise.resolve(preRead.length > maxBytes ? { json: undefined, raw: '', error: 'too-large' } : { json: undefined, raw: preRead });
  }
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

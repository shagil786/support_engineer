/**
 * HTTP traffic middleware — rate limiting, idempotent dispatch, and the
 * per-request caches they need. Extracted from server.ts so the HTTP file
 * owns ROUTING and the middleware owns TRAFFIC POLICY.
 *
 *  - Rate limiting: per-credential token buckets. Bearer routes key on the
 *    VALIDATED token (a 401 flood cannot mint buckets); Slack routes key on
 *    the source IP (the credential IS the HMAC). Refill is continuous.
 *  - Idempotency: replay a stored 2xx for the same (credential, key),
 *    coalesce concurrent same-key requests into one execution, store the
 *    result when settled (2xx only — a failed attempt can be retried with
 *    the same key). Keys are opt-in via the Idempotency-Key header except
 *    on approval execute, where the route auto-scopes by
 *    credential+path+body so double-clicks cannot double-execute.
 *  - Body peeking: reads a request stream ONCE and caches the raw body on
 *    the request, so a later readBody finds it already there (a consumed
 *    stream would hang readBody forever).
 *
 * Both caches have TTL sweeps and hard caps — they never grow unbounded.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A stored idempotent response: status, JSON body, and header markers. */
export interface CachedResponse {
  status: number;
  body: unknown;
  createdAt: number;
}

interface InFlight {
  promise: Promise<CachedResponse>;
  createdAt: number;
}

/** Idempotency caches never grow unbounded: TTL sweep + hard cap. */
const IDEMPOTENCY_MAX_ENTRIES = 10_000;
/** Idle buckets older than a minute are reclaimed once the map overflows. */
const BUCKET_IDLE_MS = 60_000;

export interface TrafficOptions {
  /** Requests per minute per credential (the bucket capacity). */
  rateLimitPerMinute: number;
  /** How long a stored idempotent response replays (default 24h). */
  idempotencyTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class HttpTraffic {
  private readonly capacity: number;
  private readonly idemTtl: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly idemResponses = new Map<string, CachedResponse>();
  private readonly idemInFlight = new Map<string, InFlight>();
  /** Validated bearer credential per response — set by the route dispatcher
   *  after auth, read by the idempotency layer for cache scoping. */
  private readonly routeContexts = new WeakMap<ServerResponse, { credential: string }>();
  private readonly peekedBodies = new WeakMap<IncomingMessage, string>();

  constructor(opts: TrafficOptions) {
    this.capacity = opts.rateLimitPerMinute;
    this.idemTtl = opts.idempotencyTtlMs ?? 24 * 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Consume one token from the credential's bucket; false when exhausted. */
  limit(credential: string): boolean {
    const t = this.now();
    const refillPerMs = this.capacity / 60_000;
    let b = this.buckets.get(credential);
    if (!b) {
      b = { tokens: this.capacity, updatedAt: t };
      this.buckets.set(credential, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.updatedAt) * refillPerMs);
    b.updatedAt = t;
    if (b.tokens < 1) return true;
    b.tokens -= 1;
    if (this.buckets.size > IDEMPOTENCY_MAX_ENTRIES) {
      for (const [k, bb] of this.buckets) {
        if (t - bb.updatedAt > BUCKET_IDLE_MS) this.buckets.delete(k);
      }
    }
    return false;
  }

  /** Record the validated credential for a response (post-auth). */
  markCredential(res: ServerResponse, credential: string): void {
    this.routeContexts.set(res, { credential });
  }

  /** Body peek for auto-keying and pre-read reuse: reads the stream ONCE
   *  and caches the raw body on the request. */
  async peekBody(req: IncomingMessage): Promise<string> {
    const cached = this.peekedBodies.get(req);
    if (cached !== undefined) return cached;
    const raw = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
    this.peekedBodies.set(req, raw);
    return raw;
  }

  /** The raw body peeked earlier, if any (readBody's preRead). */
  peekedBody(req: IncomingMessage): string | undefined {
    return this.peekedBodies.get(req);
  }

  /** Idempotent dispatch: replay/coalesce/store per (credential, scope, key)
   *  and write the response. See the module header for the contract. */
  async dispatchIdempotent(
    req: IncomingMessage,
    res: ServerResponse,
    routeScope: string,
    run: () => Promise<CachedResponse>,
    o: { autoKey?: boolean; ttl?: number } = {},
  ): Promise<void> {
    const credential = this.routeContexts.get(res)?.credential ?? 'unknown';
    const ttl = o.ttl ?? this.idemTtl;
    const rawHeader = req.headers['idempotency-key'];
    const clientKeyHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    let key: string | undefined = clientKeyHeader?.trim() || undefined;
    if (!key && o.autoKey) {
      // Best-effort body signature so the same action executed twice with an
      // identical body coalesces; differing bodies are distinct operations.
      const raw = await this.peekBody(req);
      key = 'auto:' + createHash('sha256').update(raw).digest('hex').slice(0, 32);
    }
    if (!key) {
      const r = await run();
      return sendCached(res, r);
    }
    const scoped = `${credential}:${routeScope}:${key}`;
    const stored = this.idemResponses.get(scoped);
    if (stored && this.now() - stored.createdAt <= ttl) {
      return sendCached(res, stored, true);
    }
    if (stored) this.idemResponses.delete(scoped);
    const inflight = this.idemInFlight.get(scoped);
    if (inflight) {
      const shared = await inflight.promise;
      return sendCached(res, shared, true);
    }
    const p = run()
      .then((r) => {
        if (r.status >= 200 && r.status < 300) {
          this.idemResponses.set(scoped, r);
          if (this.idemResponses.size > IDEMPOTENCY_MAX_ENTRIES) {
            for (const [k, v] of this.idemResponses) {
              if (this.now() - v.createdAt > this.idemTtl) this.idemResponses.delete(k);
            }
          }
        }
        return r;
      })
      .finally(() => this.idemInFlight.delete(scoped));
    this.idemInFlight.set(scoped, { promise: p, createdAt: this.now() });
    const r = await p;
    sendCached(res, r);
  }
}

function sendCached(res: ServerResponse, r: CachedResponse, replay = false): void {
  void res.writeHead(r.status, {
    'content-type': 'application/json',
    ...(replay ? { 'idempotent-replay': 'true' } : {}),
  });
  res.end(JSON.stringify(r.body));
}

/** 429 with a nudge header. Callers answer 429 BEFORE touching the platform. */
export function tooMany(res: ServerResponse): void {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
  res.end(JSON.stringify({ error: 'rate limit exceeded; slow down' }));
}

/** The rate-limit credential for unauthenticated routes: the source IP. */
export function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown-ip';
}

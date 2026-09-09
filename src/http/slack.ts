/**
 * Slack webhook handlers for the HTTP surface (spec §3 surfaces).
 *
 * Two routes, both verified with Slack's v0 HMAC scheme before any platform
 * code runs:
 *  - POST /slack/events       Events API: url_verification, app_mention /
 *                             message (→ pipeline), reaction_added (→ gate).
 *  - POST /slack/interactive  Block Kit button clicks (→ gate handleAction).
 *
 * The signer's role is ALWAYS resolved server-side from the Slack user id via
 * the platform registry — a reaction or click is a claim, not a credential.
 * Event deliveries dedupe by event_id (Slack retries aggressively).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Platform } from '../bootstrap.js';

export interface InteractivePayload {
  type?: string;
  user?: { id?: string };
  actions?: Array<{ action_id?: string }>;
}

const SLACK_DEDUPE_TTL_MS = 5 * 60_000;
const SLACK_DEDUPE_MAX = 5_000;

export function verifySlackSignature(secret: string, presented: string, ts: string, rawBody: string, now: () => number): boolean {
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now() / 1000 - tsNum) > 300) return false;
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? { ok: true, value: v } : { ok: false, error: 'body is not valid JSON' };
  } catch {
    return { ok: false, error: 'body is not valid JSON' };
  }
}

export function pruneDedupe(map: Map<string, number>, nowMs: number): void {
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

interface SlackHandlerDeps {
  platform: Platform;
  signingSecret: string | undefined;
  maxBody: number;
  now: () => number;
  reply: (res: ServerResponse, status: number, body: unknown, contentType?: string) => void;
  readBody: (req: IncomingMessage, maxBytes: number, preRead?: string) => Promise<{ json: unknown; raw: string; error?: 'too-large' }>;
  seenSlackEvents: Map<string, number>;
}

export function createSlackHandlers(deps: SlackHandlerDeps): {
  handleSlack: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleSlackInteractive: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const { platform, signingSecret, maxBody, now, reply, readBody, seenSlackEvents } = deps;

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

    const parsed = parseJson(body.raw);
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
        thread_ts?: string;
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
    // Meeting targeting: a threaded message (thread_ts) is part of a specific
    // conversation — memory and approvals scope to the channel, not the user.
    const meetingChannel = typeof event.channel === 'string' && event.channel.trim() !== '' ? event.channel.trim() : undefined;
    // The thread root: Slack sets thread_ts on every reply in a thread; when
    // absent (a top-of-thread message that starts the conversation) the
    // message's own ts IS the thread root.
    const threadTs = typeof event.thread_ts === 'string' && event.thread_ts.trim() !== '' ? event.thread_ts.trim() : (typeof event.ts === 'string' && event.ts.trim() !== '' ? event.ts.trim() : undefined);
    try {
      await platform.pipeline.processUtterance(speaker, text, now(), meetingChannel, threadTs);
    } catch {
      // Already logged by the pipeline's own degradation; ack regardless so
      // Slack does not retry an event we cannot process.
    }
    return reply(res, 200, { ok: true });
  }

  return { handleSlack, handleSlackInteractive };
}

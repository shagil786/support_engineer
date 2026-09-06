/**
 * SlackBotClient — bot-token Slack integration (Web API).
 *
 * The incoming-webhook notifier (slack.ts) can only blast text into a
 * channel; it cannot resolve which message it posted, so emoji reactions can
 * never be correlated to a specific approval. A bot token can: chat.postMessage
 * returns `{ channel, ts }`, and the same token receives `reaction_added`
 * events. Together they turn the security channel into a real approval UX.
 *
 * Satisfies SlackLike (and the legacy SlackNotifier) so it drops into
 * ApprovalGate / createPlatform unchanged.
 */
export interface SlackBotConfig {
  /** Slack bot user token starting with xoxb-. */
  botToken: string;
  /** Injectable fetch for tests / proxies. */
  request?: typeof fetch;
}

interface SlackApiOk {
  ok: true;
  channel?: string;
  ts?: string;
}

interface SlackApiErr {
  ok: false;
  error?: string;
}

const SLACK_API = 'https://slack.com/api';

export class SlackBotClient {
  private readonly cfg: SlackBotConfig;

  constructor(cfg: SlackBotConfig) {
    this.cfg = cfg;
  }

  private get http(): typeof fetch {
    return this.cfg.request ?? fetch;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<SlackApiOk> {
    const res = await this.http(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.cfg.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Slack API ${method} failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }
    const parsed = (await res.json().catch(() => null)) as SlackApiOk | SlackApiErr | null;
    if (!parsed || parsed.ok !== true) {
      throw new Error(`Slack API ${method} error: ${(parsed as SlackApiErr | null)?.error ?? 'unknown'}`);
    }
    return parsed;
  }

  /** Post a message and resolve its ref — the piece webhooks cannot do. */
  async postMessageWithRef(channel: string, text: string): Promise<{ channel: string; ts: string }> {
    const r = await this.call('chat.postMessage', { channel, text });
    if (!r.channel || !r.ts) throw new Error(`Slack API chat.postMessage did not return a message ref`);
    return { channel: r.channel, ts: r.ts };
  }

  /** Edit a posted message in place (chat.update) — the ApprovalGate uses
   *  this to keep the original request message as the lifecycle record. */
  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await this.call('chat.update', { channel, ts, text });
  }

  /** Reply in-thread under a message (chat.postMessage + thread_ts). */
  async postReply(channel: string, ts: string, text: string): Promise<void> {
    await this.call('chat.postMessage', { channel, thread_ts: ts, text });
  }

  /** SlackLike / SlackNotifier compatibility: post and discard the ref. */
  async postMessage(channel: string, text: string): Promise<void> {
    await this.postMessageWithRef(channel, text);
  }
}

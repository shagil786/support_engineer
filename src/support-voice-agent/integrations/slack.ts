/** Slack outgoing messages (meeting summaries) via an incoming webhook. */

export interface SlackNotifier {
  postMessage(channel: string, text: string): Promise<void>;
}

export interface SlackWebhookConfig {
  webhookUrl: string;
  /** Injectable fetch for tests / proxies. */
  request?: typeof fetch;
}

export class SlackWebhookNotifier implements SlackNotifier {
  constructor(private readonly cfg: SlackWebhookConfig) {}

  private get http(): typeof fetch {
    return this.cfg.request ?? fetch;
  }

  async postMessage(channel: string, text: string): Promise<void> {
    const res = await this.http(this.cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text }),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }
  }
}
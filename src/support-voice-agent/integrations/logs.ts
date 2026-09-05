/** Log providers (Splunk, CloudWatch Logs) behind a common interface. */

import type { LogProvider, LogQuery, LogQueryResult, LogRow } from '../types';
export type { LogQuery, LogProvider, LogQueryResult, LogRow } from '../types';

export class LogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogError';
  }
}

function basicAuth(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  return typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw).toString('base64');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Splunk — REST oneshot export (newline-delimited JSON).              */
/* ------------------------------------------------------------------ */

export interface SplunkConfig {
  baseUrl: string;
  /** Splunk auth token (recommended) or username/password. */
  token?: string;
  username?: string;
  password?: string;
  /** Injectable fetch for tests / proxies. */
  request?: typeof fetch;
}

export class SplunkProvider implements LogProvider {
  readonly name = 'Splunk';

  constructor(private readonly cfg: SplunkConfig) {}

  private get http(): typeof fetch {
    return this.cfg.request ?? fetch;
  }

  async query(q: LogQuery): Promise<LogQueryResult> {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    const params = new URLSearchParams({
      search: q.query,
      exec_mode: 'oneshot',
      output_mode: 'json',
      max_count: String(q.limit ?? 50),
      earliest_time: q.earliest ?? (q.from !== undefined ? new Date(q.from).toISOString() : '-15m'),
      latest_time: q.latest ?? (q.to !== undefined ? new Date(q.to).toISOString() : 'now'),
    });
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(this.cfg.token
        ? { Authorization: `Splunk ${this.cfg.token}` }
        : this.cfg.username
          ? { Authorization: `Basic ${basicAuth(this.cfg.username, this.cfg.password ?? '')}` }
          : {}),
    };
    const started = Date.now();
    const res = await this.http(`${base}/services/search/jobs/export`, {
      method: 'POST',
      headers,
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LogError(`Splunk export failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const body = await res.text();
    const rows = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, q.limit ?? 50)
      .map((line): { ts?: number; message: string; fields?: Record<string, unknown> } => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const raw = parsed['_raw'];
          return {
            ts: typeof parsed['_time'] === 'string' ? new Date(parsed['_time']).getTime() : undefined,
            message: typeof raw === 'string' ? raw : JSON.stringify(parsed),
            fields: parsed,
          };
        } catch {
          return { message: line };
        }
      });
    return { rows, provider: this.name, durationMs: Date.now() - started };
  }
}

/* ------------------------------------------------------------------ */
/* CloudWatch Logs Insights — StartQuery / GetQueryResults.            */
/* ------------------------------------------------------------------ */

/** Produces signing headers (Authorization: AWS4-HMAC-...) for a request. */
export type AwsSigner = (method: string, url: string, body: string) => Promise<Record<string, string>>;

export interface CloudWatchConfig {
  region: string;
  logGroupNames?: string[];
  /** Host-provided SigV4 signer (e.g. built on the AWS SDK or a pre-signed credentials helper). */
  signer: AwsSigner;
  /** Injectable fetch for tests / proxies. */
  request?: typeof fetch;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export type CloudWatchCell = {
  field: string;
  value: string;
};

export class CloudWatchProvider implements LogProvider {
  readonly name = 'CloudWatch Logs';

  constructor(private readonly cfg: CloudWatchConfig) {}

  private get http(): typeof fetch {
    return this.cfg.request ?? fetch;
  }

  private endpoint(): string {
    return `https://logs.${this.cfg.region}.amazonaws.com/`;
  }

  private async call(target: string, body: unknown): Promise<unknown> {
    const url = this.endpoint();
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': target,
      ...(await this.cfg.signer('POST', url, payload)),
    };
    const res = await this.http(url, { method: 'POST', headers, body: payload });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LogError(`CloudWatch ${target} failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    return res.json();
  }

  async query(q: LogQuery): Promise<LogQueryResult> {
    const now = Date.now();
    const startTime = Math.floor((q.from ?? now - 15 * 60_000) / 1000);
    const endTime = Math.floor((q.to ?? now) / 1000);
    const started = now;
    const startedData = (await this.call('AmazonCloudWatchLogs.StartQuery', {
      logGroupNames: this.cfg.logGroupNames ?? ['/aws/lambda/*'],
      startTime,
      endTime,
      queryString: q.query,
      limit: q.limit ?? 100,
    })) as { queryId?: string };
    if (!startedData.queryId) throw new LogError('CloudWatch StartQuery returned no queryId');

    const polls = this.cfg.maxPolls ?? 10;
    const interval = this.cfg.pollIntervalMs ?? 250;
    for (let i = 0; i < polls; i++) {
      await sleep(interval);
      const data = (await this.call('AmazonCloudWatchLogs.GetQueryResults', {
        queryId: startedData.queryId,
      })) as { status?: string; results?: CloudWatchCell[][] };
      if (data.status === 'Complete' || data.status === 'Cancelled' || data.status === 'Failed') {
        const rows = (data.results ?? []).map((cells) => {
          const fields: Record<string, string> = {};
          for (const cell of cells) fields[cell.field] = cell.value;
          return {
            ts: fields['@timestamp'] ? new Date(fields['@timestamp']).getTime() : undefined,
            message: fields['@message'] ?? JSON.stringify(fields),
            fields,
          };
        });
        return {
          rows,
          provider: this.name,
          durationMs: Date.now() - started,
          truncated: rows.length >= (q.limit ?? 100),
          ...(data.status === 'Failed' ? { error: 'CloudWatch query failed' } : {}),
        };
      }
    }
    return { rows: [], provider: this.name, durationMs: Date.now() - started, error: 'Query timed out' };
  }
}

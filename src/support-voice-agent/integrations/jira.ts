/** Jira Cloud REST client (create issue, transitions, comments, status). */

import type { Severity } from '../types';

export type JiraAuth =
  | { type: 'basic'; email: string; apiToken: string }
  | { type: 'bearer'; token: string };

export interface JiraConfig {
  baseUrl: string;
  auth: JiraAuth;
  /** Default project key used when createIssue is called without one. */
  projectKey?: string;
  apiVersion?: '2' | '3';
  /** Injectable fetch for tests / proxies. */
  request?: typeof fetch;
}

export interface CreateIssueOptions {
  summary: string;
  description?: string;
  priority?: Severity | string;
  issueType?: string;
  projectKey?: string;
  labels?: string[];
  /** Extra top-level `fields` values. */
  extraFields?: Record<string, unknown>;
}

export interface CreatedIssue {
  key: string;
  id: string;
  self?: string;
}

export interface IssueInfo {
  key: string;
  summary: string;
  status: string;
}

export class JiraError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
  }
}

function authHeaders(auth: JiraAuth): Record<string, string> {
  if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` };
  const raw = `${auth.email}:${auth.apiToken}`;
  const encoded = typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

/** Map a Severity to a standard Jira priority name (or pass through custom strings). */
export function jiraPriorityName(priority: Severity | string): string {
  switch (priority) {
    case 'P0':
      return 'Highest';
    case 'P1':
      return 'High';
    case 'P2':
      return 'Medium';
    case 'P3':
      return 'Low';
    case 'P4':
      return 'Lowest';
    default:
      return priority;
  }
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly apiVersion: '2' | '3';
  private readonly http: typeof fetch;

  constructor(private readonly cfg: JiraConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiVersion = cfg.apiVersion ?? '3';
    // Lazy resolution keeps late global-fetch patches (tests, offline demo)
    // working for clients constructed before those patches are installed.
    this.http = cfg.request ?? ((input, init) => fetch(input, init));
  }

  private url(path: string): string {
    return `${this.baseUrl}/rest/api/${this.apiVersion}${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(this.url(path), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(this.cfg.auth),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new JiraError(`Jira ${method} ${path} failed (${res.status}): ${detail.slice(0, 500)}`, res.status);
    }
    if (res.status === 204 || res.status === 200) {
      const text = await res.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    }
    return (await res.json()) as T;
  }

  async createIssue(opts: CreateIssueOptions): Promise<CreatedIssue> {
    const projectKey = opts.projectKey ?? this.cfg.projectKey;
    if (!projectKey) throw new JiraError('No project key: pass projectKey or configure jira.projectKey');
    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      summary: opts.summary,
      issuetype: { name: opts.issueType ?? 'Bug' },
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.priority !== undefined ? { priority: { name: jiraPriorityName(opts.priority) } } : {}),
      ...(opts.labels && opts.labels.length > 0 ? { labels: opts.labels } : {}),
      ...opts.extraFields,
    };
    const data = await this.request<CreatedIssue>('POST', '/issue', { fields });
    return { key: data.key, id: data.id, self: data.self };
  }

  async getIssue(issueKey: string): Promise<IssueInfo> {
    const data = await this.request<{
      key: string;
      fields?: { summary?: string; status?: { name?: string } };
    }>('GET', `/issue/${issueKey}?fields=summary,status`);
    return {
      key: data.key,
      summary: data.fields?.summary ?? '',
      status: data.fields?.status?.name ?? 'unknown',
    };
  }

  async listTransitions(issueKey: string): Promise<{ id: string; name: string }[]> {
    const data = await this.request<{ transitions?: { id: string; name: string }[] }>(
      'GET',
      `/issue/${issueKey}/transitions`,
    );
    return data.transitions ?? [];
  }

  /** Move an issue to the transition whose name matches (case-insensitive). */
  async transition(issueKey: string, transitionName: string): Promise<void> {
    const transitions = await this.listTransitions(issueKey);
    const match = transitions.find(
      (t) => t.name.toLowerCase() === transitionName.toLowerCase(),
    );
    if (!match) {
      throw new JiraError(
        `No transition named '${transitionName}' on ${issueKey} (available: ${transitions.map((t) => t.name).join(', ') || 'none'})`,
      );
    }
    await this.request('POST', `/issue/${issueKey}/transitions`, {
      transition: { id: match.id },
    });
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.request('POST', `/issue/${issueKey}/comment`, { body });
  }
}

/** Output-rule format: "I have updated TICKET-123 to status 'In Progress' and added the comment: '...'". */
export function formatJiraUpdate(opts: {
  issueKey: string;
  status?: string;
  comment?: string;
}): string {
  const { issueKey, status, comment } = opts;
  if (status && comment !== undefined) {
    return `I have updated ${issueKey} to status '${status}' and added the comment: '${comment}'.`;
  }
  if (status) {
    return `I have updated ${issueKey} to status '${status}'.`;
  }
  if (comment !== undefined) {
    return `I have added a comment to ${issueKey}: '${comment}'.`;
  }
  return `I have updated ${issueKey}.`;
}

export function formatJiraCreated(opts: { issueKey: string; priority?: Severity | string; comment?: string }): string {
  const { issueKey, priority, comment } = opts;
  const priorityPart = priority ? ` with priority '${priority}'` : '';
  const commentPart = comment !== undefined ? ` and added the comment: '${comment}'` : '';
  return `I have created ${issueKey}${priorityPart}${commentPart}.`;
}
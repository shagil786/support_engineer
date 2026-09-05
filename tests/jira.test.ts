import { describe, it, expect } from 'vitest';
import { JiraClient, JiraError, JiraConfig, formatJiraUpdate, formatJiraCreated, jiraPriorityName } from '../src/support-voice-agent/integrations/jira.ts';

describe('jiraPriorityName', () => {
  it('maps standard Jira priority names for each severity', () => {
    expect(jiraPriorityName('P0')).toBe('Highest');
    expect(jiraPriorityName('P1')).toBe('High');
    expect(jiraPriorityName('P2')).toBe('Medium');
    expect(jiraPriorityName('P3')).toBe('Low');
    expect(jiraPriorityName('P4')).toBe('Lowest');
  });
  it('passes through unknown strings unchanged', () => {
    expect(jiraPriorityName('Something Custom')).toBe('Something Custom');
  });
});

describe('formatJiraUpdate', () => {
  it('formats a status transition with a comment', () => {
    expect(formatJiraUpdate({ issueKey: 'SUPPORT-123', status: 'In Progress', comment: 'Testing now' })).toBe(
      "I have updated SUPPORT-123 to status 'In Progress' and added the comment: 'Testing now'.",
    );
  });
  it('formats a status-only update', () => {
    expect(formatJiraUpdate({ issueKey: 'SUPPORT-123', status: 'In Progress' })).toBe(
      "I have updated SUPPORT-123 to status 'In Progress'.",
    );
  });
  it('formats a comment-only update', () => {
    expect(formatJiraUpdate({ issueKey: 'SUPPORT-123', comment: 'retried' })).toBe(
      "I have added a comment to SUPPORT-123: 'retried'.",
    );
  });
  it('formats a bare update when nothing else is provided', () => {
    expect(formatJiraUpdate({ issueKey: 'SUPPORT-123' })).toBe('I have updated SUPPORT-123.');
  });
});

describe('formatJiraCreated', () => {
  it('includes priority and comment, robust newlines', () => {
    expect(formatJiraCreated({ issueKey: 'SUPPORT-123', priority: 'P1', comment: 'bug filed' })).toBe(
      "I have created SUPPORT-123 with priority 'P1' and added the comment: 'bug filed'.",
    );
  });
  it('omits optional pieces cleanly', () => {
    expect(formatJiraCreated({ issueKey: 'SUPPORT-123' })).toBe('I have created SUPPORT-123.');
    expect(formatJiraCreated({ issueKey: 'SUPPORT-123', priority: 'P2' })).toBe("I have created SUPPORT-123 with priority 'P2'.");
  });
});

class FakeRes {
  constructor(
    public ok = true,
    public status = 200,
    public body: unknown = {},
  ) {
    this.headers = new Headers();
  }

  readonly type = 'basic';
  readonly url = '';
  readonly redirected = false;
  readonly headers: Headers;
  readonly statusText = '';
  readonly bodyUsed = false;

  async text(): Promise<string> {
    return JSON.stringify(this.body);
  }
  async json(): Promise<unknown> {
    return this.body;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }
  async blob(): Promise<Blob> {
    return Promise.resolve(new Blob());
  }
  async formData(): Promise<FormData> {
    return Promise.resolve(new FormData());
  }
  async bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(0));
  }
}

describe('JiraClient with a fake HTTP server', () => {
  it('requires a project key if none is configured', async () => {
    const client = new JiraClient({
      baseUrl: 'https://jira.example.com',
      auth: { type: 'bearer', token: 't' },
      projectKey: undefined,
    });
    await expect(client.createIssue({ summary: 'x' })).rejects.toThrow('No project key');
  });

  it('returns the created issue key', async () => {
    const server = new Map<string, FakeRes>();
    const http = (url: string, opts: RequestInit): Promise<FakeRes> => {
      const match = url.match(/\/rest\/api\/\d+\/(.+)/);
      if (!match) return Promise.resolve(new FakeRes(false, 400, { error: 'bad url' }));
      const path: string = match[1] ?? '';
      if (opts.method === 'POST' && path === 'issue') {
        return Promise.resolve(server.get('issue') ?? new FakeRes(true, 200, { key: 'SUPPORT-99', id: '99', self: 'https://...' }));
      }
      if (opts.method === 'GET' && path.startsWith('issue/SUPPORT-99?fields=summary,status')) {
        return Promise.resolve(server.get('get-issue') ?? new FakeRes(true, 200, { key: 'SUPPORT-99', fields: { summary: 'Hello', status: { name: 'In Progress' } } }));
      }
      if (opts.method === 'GET' && path === 'issue/SUPPORT-99/transitions') {
        return Promise.resolve(server.get('transitions') ?? new FakeRes(true, 200, { transitions: [{ id: '1', name: 'In Progress' }, { id: '2', name: 'Done' }] }));
      }
      if (opts.method === 'POST' && path.startsWith('issue/SUPPORT-99/transitions')) return Promise.resolve(new FakeRes(true, 200, null));
      if (opts.method === 'POST' && path.startsWith('issue/SUPPORT-99/comment')) return Promise.resolve(new FakeRes(true, 204, null));
      return Promise.resolve(new FakeRes(false, 404, { error: 'not found' }));
    };
    const httpFetch = http as unknown as typeof fetch;
    const client = new JiraClient({
      baseUrl: 'https://jira.example.com',
      auth: { type: 'bearer', token: 't' },
      projectKey: 'SUPPORT',
      request: httpFetch,
    });

    const created = await client.createIssue({ summary: 'Hello' });
    expect(created.key).toBe('SUPPORT-99');
    expect(created.id).toBe('99');
  });

  it('returns issue status from a GET', async () => {
    const http = (_url: string, _opts: RequestInit): Promise<FakeRes> =>
      Promise.resolve(
        new FakeRes(true, 200, {
          key: 'SUPPORT-1',
          fields: { summary: 'Ticket', status: { name: 'In Progress' } },
        }),
      );
    const client = new JiraClient({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' }, request: http as unknown as typeof fetch });
    const info = await client.getIssue('SUPPORT-1');
    expect(info.key).toBe('SUPPORT-1');
    expect(info.status).toBe('In Progress');
    expect(info.summary).toBe('Ticket');
  });

  it('throws JiraError on non-2xx responses', async () => {
    const http = (_url: string, opts: RequestInit): Promise<FakeRes> => {
      if (opts.method === 'POST' && opts.body) {
        try {
          const body = JSON.parse(opts.body as string);
          if (!body.fields?.project) {
            return Promise.resolve(new FakeRes(false, 404, { error: 'not found' }));
          }
        } catch {}
      }
      return Promise.resolve(new FakeRes(false, 404, { error: 'not found' }));
    };
    const httpFetch = http as unknown as typeof fetch;
    const client = new JiraClient({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' }, request: httpFetch, projectKey: 'SUPPORT' });
    await expect(client.createIssue({ summary: 'x' })).rejects.toThrow(JiraError);
    await expect(client.createIssue({ summary: 'x' })).rejects.toThrow('not found');
  });

  it('transitions to a matching transition name case-insensitively', async () => {
    const http = (url: string, opts: RequestInit): Promise<FakeRes> => {
      const match = url.match(/\/rest\/api\/3\/(.*)/);
      if (!match) return Promise.resolve(new FakeRes(false, 400, { error: 'bad url' }));
      const path: string = match[1] ?? '';
      if (opts.method === 'POST' && path === 'issue/SUPPORT-1/transitions') {
        const payload = JSON.parse(opts.body as string);
        expect(payload.transition.id).toBe('1');
        return Promise.resolve(new FakeRes(true, 200, null));
      }
      return Promise.resolve(new FakeRes(true, 200, { transitions: [{ id: '1', name: 'In Progress' }, { id: '2', name: 'Done' }] }));
    };
    const httpFetchBig = http as unknown as typeof fetch;
    const client = new JiraClient({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' }, request: httpFetchBig });
    await client.transition('SUPPORT-1', 'in progress');
  });

  it('throws when the transition name does not match', async () => {
    const http = (_url: string, opts: RequestInit): Promise<FakeRes> => {
      if (opts.method === 'POST' && opts.body) return Promise.resolve(new FakeRes(true, 200, null));
      return Promise.resolve(new FakeRes(true, 200, { transitions: [{ id: '1', name: 'Done' }] }));
    };
    const httpFetch3 = http as unknown as typeof fetch;
    const client = new JiraClient({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' }, request: httpFetch3 });
    await expect(client.transition('SUPPORT-1', 'In Progress')).rejects.toThrow("No transition named 'In Progress'");
  });

  it('posts a comment', async () => {
    let capturedBody: string | undefined;
    const http = (_url: string, opts: RequestInit): Promise<FakeRes> => {
      if (opts.method === 'POST' && opts.body) capturedBody = opts.body as string;
      return Promise.resolve(new FakeRes(true, 204, null));
    };
    const httpFetch4 = http as unknown as typeof fetch;
    const client = new JiraClient({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' }, request: httpFetch4 });
    await client.addComment('SUPPORT-1', 'Agent said hi');
    expect(capturedBody).toBe(JSON.stringify({ body: 'Agent said hi' }));
  });

  it('listTransitions returns an array', async () => {
    const http = (_url: string, opts: RequestInit): Promise<FakeRes> => {
      if (opts.method !== 'GET' && opts.body) return Promise.resolve(new FakeRes(true, 200, { transitions: [{ id: '1', name: 'In Progress' }] }));
      return Promise.resolve(new FakeRes(true, 200, { transitions: [{ id: '1', name: 'In Progress' }, { id: '2', name: 'Done' }] }));
    };
    const httpFetch5 = http as unknown as typeof fetch;
    const client = new JiraClient({ baseUrl: 'https://jira.example.com', auth: { type: 'bearer', token: 't' }, request: httpFetch5 });
    const list = await client.listTransitions('SUPPORT-1');
    expect(list).toEqual([
      { id: '1', name: 'In Progress' },
      { id: '2', name: 'Done' },
    ]);
  });
});

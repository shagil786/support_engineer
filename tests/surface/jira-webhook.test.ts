import { describe, it, expect } from 'vitest';
import { parseJiraWebhook } from '../../src/surface/async/jira-webhook';

describe('parseJiraWebhook', () => {
  it('extracts ticket key and intent for a created issue', () => {
    const env = parseJiraWebhook({
      webhookEvent: 'jira:issue_created',
      issue: { key: 'SUPPORT-7', fields: { summary: 'api down' } },
    });
    expect(env?.intent).toEqual({ kind: 'async_triage', subKind: 'incident' });
    expect(env?.entities.ticketKeys).toEqual(['SUPPORT-7']);
    expect(env?.rawContext.source).toBe('jira');
  });

  it('maps non-creation events to fyi', () => {
    const env = parseJiraWebhook({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'SUPPORT-8', fields: {} },
    });
    expect(env?.intent).toEqual({ kind: 'async_triage', subKind: 'fyi' });
  });

  it('returns undefined on bad payloads', () => {
    expect(parseJiraWebhook({})).toBeUndefined();
    expect(parseJiraWebhook({ webhookEvent: 'jira:issue_created' })).toBeUndefined(); // no issue
    expect(parseJiraWebhook('not an object')).toBeUndefined();
    expect(parseJiraWebhook({ webhookEvent: 42, issue: { key: 'X', fields: {} } })).toBeUndefined();
  });
});

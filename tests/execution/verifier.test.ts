import { describe, it, expect } from 'vitest';
import { verifyResult } from '../../src/execution/verifier';

describe('verifier', () => {
  it('passes a Jira createIssue with a valid key', () => {
    expect(verifyResult('jira_create_issue', { ok: true, data: { ticket_id: 'SUPPORT-1' } }).passed).toBe(true);
  });

  it('fails a Jira createIssue with a malformed key', () => {
    const r = verifyResult('jira_create_issue', { ok: true, data: { ticket_id: 'not-a-key' } });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/key/i);
  });

  it('fails a Jira createIssue result missing the key', () => {
    const r = verifyResult('jira_create_issue', { ok: true, data: {} });
    expect(r.passed).toBe(false);
  });

  it('fails a runbook execute that did not succeed', () => {
    expect(verifyResult('execute_runbook_script', { ok: false, error: 'boom' }).passed).toBe(false);
  });

  it('passes a successful runbook execute', () => {
    expect(verifyResult('execute_runbook_script', { ok: true, data: { action_id: 'a' } }).passed).toBe(true);
  });

  it('applies the PII filter to any candidate output', () => {
    const r = verifyResult('query_logs', { ok: true, data: { rows: [] } }, {
      candidateOutput: 'the card was 4111 1111 1111 1111',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/PII|filter/i);
  });

  it('unknown tools fall back to ok/not-ok', () => {
    expect(verifyResult('meeting_interrupt', { ok: true, data: {} }).passed).toBe(true);
    expect(verifyResult('meeting_interrupt', { ok: false, error: 'x' }).passed).toBe(false);
  });
});

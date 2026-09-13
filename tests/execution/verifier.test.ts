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

  it('passes read-only evidence/change/signal results, fails their errors', () => {
    expect(verifyResult('query_evidence', { ok: true, data: { nodes: [] } }).passed).toBe(true);
    expect(verifyResult('correlate_changes', { ok: true, data: { suspects: [] } }).passed).toBe(true);
    expect(verifyResult('query_signals', { ok: true, data: {} }).passed).toBe(true);
    expect(verifyResult('query_evidence', { ok: false, error: 'unwired' }).passed).toBe(false);
  });

  it('requires a real risk tier on blast assessments', () => {
    expect(verifyResult('assess_blast_radius', { ok: true, data: { risk: 'medium' } }).passed).toBe(true);
    expect(verifyResult('assess_blast_radius', { ok: true, data: {} }).passed).toBe(false);
  });

  it('requires a confirmed verdict on remediation verification', () => {
    expect(verifyResult('verify_remediation', { ok: true, data: { passed: true } }).passed).toBe(true);
    expect(verifyResult('verify_remediation', { ok: true, data: { passed: false } }).passed).toBe(false);
    expect(verifyResult('verify_remediation', { ok: false, error: 'not verified → escalate' }).passed).toBe(false);
  });

  it('unknown tools fall back to ok/not-ok', () => {
    expect(verifyResult('meeting_interrupt', { ok: true, data: {} }).passed).toBe(true);
    expect(verifyResult('meeting_interrupt', { ok: false, error: 'x' }).passed).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../../src/governance/policy-engine';
import type { IntentEnvelope } from '../../src/event-log/types';

const env = (over: Partial<IntentEnvelope> = {}): IntentEnvelope => ({
  intent: { kind: 'meeting_response', subKind: 'question' },
  confidence: 1,
  entities: {},
  rawContext: { source: 'meeting', ts: 1, payload: {} },
  ...over,
});

describe('PolicyEngine', () => {
  it('returns allow when a tools_in rule matches', () => {
    const e = new PolicyEngine({
      yaml: `
rules:
  - id: default_allow_read
    when:
      tools_in: [jira_create_issue, query_logs]
    effect: allow
`,
    });
    const r = e.evaluate(env(), { tool: 'jira_create_issue', args: { project_key: 'SUP', summary: 'x', issue_type: 'Bug' } });
    expect(r.effect).toBe('allow');
    expect(r.policyIds).toContain('default_allow_read');
  });

  it('returns require_approval for a destructive runbook offer', () => {
    const e = new PolicyEngine({
      yaml: `
rules:
  - id: destructive_runbook_requires_admin_approval
    when:
      intent_subKind: runbook_offer
      runbook_destructive: true
    effect: require_approval
    approver_role: admin
    approver_count: 2
`,
    });
    const e2 = env({
      intent: { kind: 'meeting_response', subKind: 'runbook_offer' },
      entities: { runbookIds: ['restart-all'] },
    });
    const r = e.evaluate(e2, { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } });
    expect(r.effect).toBe('require_approval');
    expect(r.policyIds[0]).toBe('destructive_runbook_requires_admin_approval');
  });

  it('carries approval constraints (role, count, timeout) on the decision', () => {
    const e = new PolicyEngine({
      yaml: `
rules:
  - id: r
    when:
      tools_in: [execute_runbook_script]
    effect: require_approval
    approver_role: admin
    approver_count: 3
    timeout_seconds: 120
    on_timeout: deny
`,
    });
    const d = e.evaluate(env(), { tool: 'execute_runbook_script', args: {} });
    expect(d.approverRole).toBe('admin');
    expect(d.approverCount).toBe(3);
    expect(d.timeoutSeconds).toBe(120);
    expect(d.onTimeout).toBe('deny');
  });

  it('returns deny when an output regex rule matches', () => {
    const e = new PolicyEngine({
      yaml: `
rules:
  - id: no_post_credit_cards
    when:
      output_matches_regex: '\\b(?:\\d[ -]*?){13,19}\\b'
    effect: deny
    reason: PII guard
`,
    });
    const r = e.evaluate(env(), { tool: 'invoke_human_on_slack', args: { target_user: 'x', message: 'card 4111 1111 1111 1111' } });
    expect(r.effect).toBe('deny');
    expect(r.reason).toBe('PII guard');
  });

  it('first matching rule wins (deny beats later allow)', () => {
    const e = new PolicyEngine({
      yaml: `
rules:
  - id: deny_meetings
    when:
      intent_kind: meeting_response
    effect: deny
  - id: allow_all_tools
    when:
      tools_in: [query_logs]
    effect: allow
`,
    });
    const r = e.evaluate(env(), { tool: 'query_logs', args: {} });
    expect(r.effect).toBe('deny');
    expect(r.policyIds).toEqual(['deny_meetings']);
  });

  it('defaults to deny when nothing matches', () => {
    const e = new PolicyEngine({ yaml: 'rules: []\n' });
    const r = e.evaluate(env(), { tool: 'query_logs', args: {} });
    expect(r.effect).toBe('deny');
    expect(r.reason).toMatch(/no matching policy/);
  });

  it('severity_in gates on envelope entities', () => {
    const e = new PolicyEngine({
      yaml: `
rules:
  - id: p1_auto_file
    when:
      intent_kind: proactive_alert
      severity_in: [P0, P1]
    effect: allow
`,
    });
    const ok = env({
      intent: { kind: 'proactive_alert', subKind: 'incident' },
      entities: { severity: 'P1' },
      rawContext: { source: 'cloudwatch', ts: 1, payload: {} },
    });
    const noSeverity = env({
      intent: { kind: 'proactive_alert', subKind: 'incident' },
      rawContext: { source: 'cloudwatch', ts: 1, payload: {} },
    });
    expect(e.evaluate(ok, { tool: 'jira_create_issue', args: {} }).effect).toBe('allow');
    expect(e.evaluate(noSeverity, { tool: 'jira_create_issue', args: {} }).effect).toBe('deny');
  });

  it('rejects invalid bundles at load (unknown effect, non-string id)', () => {
    expect(() => new PolicyEngine({ yaml: 'rules:\n  - id: x\n    effect: maybe\n' })).toThrow();
    expect(() => new PolicyEngine({ yaml: 'rules:\n  - id: 7\n    effect: allow\n' })).toThrow();
  });

  it('rejects unknown top-level keys in a rule', () => {
    expect(() =>
      new PolicyEngine({ yaml: 'rules:\n  - id: x\n    effect: allow\n    hackers: true\n' }),
    ).toThrow();
  });
});

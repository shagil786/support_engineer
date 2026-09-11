import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolicyEngine } from '../../src/governance/policy-engine';
import type { IntentEnvelope } from '../../src/event-log/types';
import type { ProposedAction } from '../../src/governance/decision';

const yaml = readFileSync(join(process.cwd(), 'policies/default.yaml'), 'utf8');
const engine = new PolicyEngine({ yaml });

const env = (over: Partial<IntentEnvelope> = {}): IntentEnvelope => ({
  intent: { kind: 'meeting_response', subKind: 'question' },
  confidence: 1,
  entities: {},
  rawContext: { source: 'meeting', ts: 1, payload: {} },
  ...over,
});

describe('policies/default.yaml parity with today\'s behavior', () => {
  it('read-only log query is allowed', () => {
    const r = engine.evaluate(env(), { tool: 'query_logs', args: { query_string: 'errors' } });
    expect(r.effect).toBe('allow');
    expect(r.policyIds).toContain('read_only_default_allow');
  });

  it('destructive runbook offer requires 2 admin signatures', () => {
    const e = env({
      intent: { kind: 'meeting_response', subKind: 'runbook_offer' },
      entities: { runbookIds: ['restart-all'] },
    });
    const r = engine.evaluate(e, { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } });
    expect(r.effect).toBe('require_approval');
    expect(r.policyIds[0]).toBe('destructive_runbook_requires_admin_approval');
    expect(r.approverRole).toBe('admin');
    expect(r.approverCount).toBe(2);
    expect(r.timeoutSeconds).toBe(300);
    expect(r.onTimeout).toBe('deny');
  });

  it('non-destructive runbook stays allowed (today: no approval gate)', () => {
    const e = env({
      intent: { kind: 'meeting_response', subKind: 'runbook_offer' },
      entities: { runbookIds: ['restart-checkout'] },
    });
    const r = engine.evaluate(e, { tool: 'execute_runbook_script', args: { script_name: 'restart-checkout' } });
    expect(r.effect).toBe('allow');
  });

  it('ticket creation from speech is allowed (today: direct handler)', () => {
    const r = engine.evaluate(env(), {
      tool: 'jira_create_issue',
      args: { project_key: 'SUP', summary: 'checkout 502s', issue_type: 'Bug' },
    });
    expect(r.effect).toBe('allow');
  });

  it('credit card number in any args is denied (PII guard)', () => {
    const r = engine.evaluate(env(), {
      tool: 'invoke_human_on_slack',
      args: { target_user: 'oncall', message: 'card 4111 1111 1111 1111' },
    });
    expect(r.effect).toBe('deny');
    expect(r.policyIds).toContain('never_emit_credit_card');
  });

  it('P1 alert auto-filing and interruption are allowed', () => {
    const e = env({
      intent: { kind: 'proactive_alert', subKind: 'incident' },
      entities: { severity: 'P1' },
      rawContext: { source: 'cloudwatch', ts: 1, payload: {} },
    });
    expect(engine.evaluate(e, { tool: 'jira_create_issue', args: { summary: 'api down' } }).effect).toBe('allow');
    expect(engine.evaluate(e, { tool: 'meeting_interrupt', args: { message: 'P1' } }).effect).toBe('allow');
  });

  it('destructive runbooks require approval regardless of intent (alerts included)', () => {
    const e = env({
      intent: { kind: 'proactive_alert', subKind: 'incident' },
      entities: { severity: 'P1', runbookIds: ['restart-all'] },
      rawContext: { source: 'cloudwatch', ts: 1, payload: {} },
    });
    const r = engine.evaluate(e, { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } });
    expect(r.effect).toBe('require_approval');
    expect(r.policyIds[0]).toBe('destructive_runbook_requires_admin_approval');
    expect(r.approverCount).toBe(2);
  });

  it('an unknown tool is default-denied', () => {
    const r = engine.evaluate(env(), { tool: 'deploy_to_prod' as ProposedAction['tool'], args: {} });
    expect(r.effect).toBe('deny');
    expect(r.reason).toMatch(/no matching policy/);
  });
});

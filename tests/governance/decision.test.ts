import { describe, it, expect } from 'vitest';
import type { ProposedAction, GovernedAction, Decision } from '../../src/governance/decision';
import { isGovernedAction } from '../../src/governance/decision';

const baseDecision: Decision = { effect: 'allow', reason: 'test', policyIds: [] };

describe('Governance decision types', () => {
  it('round-trips execute', () => {
    const ga: GovernedAction = {
      kind: 'execute',
      action: { tool: 'jira_create_issue', args: { project_key: 'SUP', summary: 'x', issue_type: 'Bug' } },
      decision: baseDecision,
    };
    expect(isGovernedAction(ga)).toBe(true);
    expect(ga.kind).toBe('execute');
  });

  it('round-trips request_approval', () => {
    const ga: GovernedAction = {
      kind: 'request_approval',
      action: { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } },
      decision: baseDecision,
      approvalId: 'a1',
    };
    expect(ga.kind).toBe('request_approval');
  });

  it('round-trips deny', () => {
    const ga: GovernedAction = { kind: 'deny', decision: { ...baseDecision, effect: 'deny' } };
    expect(ga.kind).toBe('deny');
  });

  it('rejects an unknown kind', () => {
    expect(isGovernedAction({ kind: 'explode' } as unknown)).toBe(false);
  });

  it('rejects non-objects and null', () => {
    expect(isGovernedAction(null)).toBe(false);
    expect(isGovernedAction('execute')).toBe(false);
    expect(isGovernedAction(undefined)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalRunner } from '../../src/learning/eval-runner';
import { PolicyEngine } from '../../src/governance/policy-engine';

const defaultYaml = readFileSync(join(process.cwd(), 'policies/default.yaml'), 'utf8');
const scenariosYaml = readFileSync(join(process.cwd(), 'policies/eval/scenarios.yaml'), 'utf8');

describe('EvalRunner', () => {
  it('passes every shipped scenario against the default bundle', () => {
    const engine = new PolicyEngine({ yaml: defaultYaml });
    const runner = new EvalRunner({ engine });
    const r = runner.runScenarios(scenariosYaml);
    expect(r.total).toBeGreaterThanOrEqual(7);
    expect(r.passed).toBe(r.total);
    expect(r.failures).toEqual([]);
  });

  it('reports failures when a bundle regresses behavior', () => {
    // Bundle without the destructive-runbook rule → that scenario must fail.
    const regressed = new PolicyEngine({ yaml: 'rules:\n  - id: allow_all\n    when:\n      tools_in: [query_logs, execute_runbook_script, jira_create_issue, meeting_interrupt, invoke_human_on_slack]\n    effect: allow\n' });
    const runner = new EvalRunner({ engine: regressed });
    const r = runner.runScenarios(scenariosYaml);
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures.some((f) => f.id === 'destructive_runbook_requires_approval' && f.expected === 'require_approval' && f.got === 'allow')).toBe(true);
  });

  it('rejects scenario files with unknown fields (fails loud, not silent)', () => {
    const engine = new PolicyEngine({ yaml: defaultYaml });
    const runner = new EvalRunner({ engine });
    expect(() => runner.runScenarios('scenarios:\n  - id: x\n    bogus: true\n')).toThrow();
  });
});

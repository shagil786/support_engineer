import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSafetyNetRegression } from '../../src/learning/safety-net-regression';
import { SafetyNet } from '../../src/governance/safety-net';

const shippedYaml = readFileSync(
  join(process.cwd(), 'policies/eval/safety_net_regression.yaml'),
  'utf8',
);

describe('runSafetyNetRegression (standalone)', () => {
  it('passes the shipped regression scenarios against a default SafetyNet', () => {
    // Must not throw: every shipped scenario vetoes for its expected check.
    expect(() => runSafetyNetRegression(shippedYaml, new SafetyNet({}))).not.toThrow();
  });

  it('throws when a scenario fails to veto at all', () => {
    const yaml = `scenarios:
  - id: benign_should_veto_anyway
    intent: { kind: meeting_response, subKind: question }
    entities: {}
    action: { tool: query_logs, args: { query_string: errors } }
    speakerId: u1
    expected_safety_net: rbac
`;
    expect(() => runSafetyNetRegression(yaml, new SafetyNet({}))).toThrow(
      /benign_should_veto_anyway.*did not veto/,
    );
  });

  it('throws when a scenario vetoes for the wrong reason', () => {
    // Output filter fires (credit card), but the scenario expects rbac.
    const yaml = `scenarios:
  - id: wrong_reason
    intent: { kind: meeting_response, subKind: question }
    entities: {}
    action: { tool: invoke_human_on_slack, args: { target_user: oncall, message: 'card 4111 1111 1111 1111' } }
    speakerId: u1
    expected_safety_net: rbac
`;
    expect(() => runSafetyNetRegression(yaml, new SafetyNet({}))).toThrow(
      /wrong_reason.*vetoed for the wrong reason \(expected rbac\)/,
    );
  });

  it('fails loud on malformed scenario files (missing required fields)', () => {
    const yaml = `scenarios:
  - id: no_speaker
    action: { tool: query_logs, args: {} }
    expected_safety_net: rbac
`;
    expect(() => runSafetyNetRegression(yaml, new SafetyNet({}))).toThrow();
  });
});

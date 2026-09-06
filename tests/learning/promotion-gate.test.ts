import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromotionGate } from '../../src/learning/promotion-gate';
import { PolicyStore } from '../../src/governance/policy-store';
import { PolicyEngine } from '../../src/governance/policy-engine';
import { SafetyNet } from '../../src/governance/safety-net';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { PolicySuggestion } from '../../src/learning/suggestion-queue';

const defaultYaml = readFileSync(join(process.cwd(), 'policies/default.yaml'), 'utf8');
const evalScenariosPath = join(process.cwd(), 'policies/eval/scenarios.yaml');
const safetyNetScenariosPath = join(process.cwd(), 'policies/eval/safety_net_regression.yaml');

let dir: string;
let store: PolicyStore;

const relaxApprovals: PolicySuggestion = {
  id: 's1',
  rationale: 'test: relax approver count',
  evidence: { outcomeIds: [], sampleSize: 0, confidence: 1 },
  proposedChange: { type: 'modify_rule', ruleId: 'destructive_runbook_requires_admin_approval', patch: { approver_count: 1 } },
  risk: 'high',
  estimatedImpact: { outcomeMetric: 'latency', expectedDelta: '−50%' },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'promo-'));
  store = new PolicyStore({ dbPath: join(dir, 'p.db'), yamlDir: join(dir, 'bundles') });
  const v1 = await store.save({ yaml: defaultYaml, authoredBy: 'alice', signedBy: 'alice' });
  await store.promote(v1.version, { promotedBy: ['admin1', 'admin2'], evalRunId: 'e1', safetyNetPassed: true });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const makeGate = (over: Partial<ConstructorParameters<typeof PromotionGate>[0]> = {}) =>
  new PromotionGate({
    store,
    safetyNet: new SafetyNet({}),
    evalScenariosPath,
    safetyNetScenariosPath,
    ...over,
  });

describe('PromotionGate', () => {
  it('promotes when eval + SafetyNet regression + 2 signatures all pass', async () => {
    const gate = makeGate();
    const v2 = await gate.promote(relaxApprovals, ['admin1', 'admin2']);
    expect(v2.version).toBeGreaterThan(1);
    expect(store.current().version).toBe(v2.version);
    // The patch actually landed in the current bundle.
    expect(store.current().yaml).toContain('approver_count: 1');
    expect(store.current().promotedBy).toEqual(['admin1', 'admin2']);
  });

  it('rejects fewer than 2 signatures', async () => {
    const gate = makeGate();
    await expect(gate.promote(relaxApprovals, ['admin1'])).rejects.toThrow(/2 signatures/);
  });

  it('rejects signers without the policy_admin role when a role resolver is wired', async () => {
    const gate = makeGate({ hasPolicyAdminRole: (id) => id.startsWith('admin') });
    await expect(gate.promote(relaxApprovals, ['admin1', 'intern1'])).rejects.toThrow(/policy_admin/);
  });

  it('evaluates the CANDIDATE bundle, not the current one', async () => {
    const gate = makeGate();
    // Patch flips the destructive rule to allow → the shipped eval scenario
    // destructive_runbook_requires_approval must fail → promotion refused.
    const bad: PolicySuggestion = {
      ...relaxApprovals,
      proposedChange: { type: 'modify_rule', ruleId: 'destructive_runbook_requires_admin_approval', patch: { effect: 'allow' } },
    };
    await expect(gate.promote(bad, ['admin1', 'admin2'])).rejects.toThrow(/Eval failed/);
    // Store unchanged.
    expect(store.current().version).toBe(1);
  });

  it('refuses unsupported change types with a clear error', async () => {
    const gate = makeGate();
    const wrong: PolicySuggestion = {
      ...relaxApprovals,
      proposedChange: { type: 'tighten_safety_net', check: 'rbac' },
    };
    await expect(gate.promote(wrong, ['admin1', 'admin2'])).rejects.toThrow(/SafetyNet changes are code changes/);
  });

  it('refuses to patch a rule that does not exist', async () => {
    const gate = makeGate();
    const ghost: PolicySuggestion = {
      ...relaxApprovals,
      proposedChange: { type: 'modify_rule', ruleId: 'no_such_rule', patch: { effect: 'allow' } },
    };
    await expect(gate.promote(ghost, ['admin1', 'admin2'])).rejects.toThrow(/rule not found/);
  });

  it('emits policy_promoted to the event log when wired', async () => {
    const eventsDir = join(dir, 'events');
    const log = new JsonlFileEventLog({ baseDir: eventsDir });
    const gate = makeGate({ eventLog: log });
    const v2 = await gate.promote(relaxApprovals, ['admin1', 'admin2']);
    const events = [];
    for await (const e of log.query({ kind: 'policy_promoted' })) events.push(e);
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev?.kind === 'policy_promoted') {
      expect(ev.bundleSha).toBe(v2.sha256);
      expect(ev.promotedBy).toEqual(['admin1', 'admin2']);
    } else {
      expect.fail('expected a policy_promoted event');
    }
  });
});

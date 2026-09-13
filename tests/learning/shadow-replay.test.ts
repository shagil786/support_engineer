/**
 * ShadowReplay (ADR-0010) — replay recorded governance traffic from the
 * event spine against a candidate policy bundle and diff against the live
 * decisions. The spine stays REAL (JsonlFileEventLog over a temp dir); only
 * the engine is constructed per scenario. Pinned invariants:
 *  - The FIRST governance event per correlationId is the vote; the blast
 *    escalation's re-audit never double-counts the same request.
 *  - Legacy action-less events are counted, never fatal.
 *  - An empty spine is zero replays and green — a harness must not depend
 *    on having traffic.
 *  - A corrupt spine is a harness failure (fail-closed), never a pass.
 *  - The PromotionGate refuses a candidate that diverges on real traffic —
 *    even one that passes every handwritten eval scenario.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowReplay } from '../../src/learning/shadow-replay';
import { PromotionGate } from '../../src/learning/promotion-gate';
import type { PolicySuggestion } from '../../src/learning/suggestion-queue';
import { PolicyEngine } from '../../src/governance/policy-engine';
import { PolicyStore } from '../../src/governance/policy-store';
import { SafetyNet } from '../../src/governance/safety-net';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { DecisionEvent, IntentEnvelope } from '../../src/event-log/types';
import type { Decision } from '../../src/governance/decision';

const defaultYaml = readFileSync(join(process.cwd(), 'policies/default.yaml'), 'utf8');
const evalScenariosPath = join(process.cwd(), 'policies/eval/scenarios.yaml');
const safetyNetScenariosPath = join(process.cwd(), 'policies/eval/safety_net_regression.yaml');

/**
 * The near-miss candidate: read-only narrowed to the two tools the
 * handwritten suite pins (query_logs, jira_get_issue). The other four
 * read-only tools (query_evidence, correlate_changes, query_signals,
 * assess_blast_radius) fall through to default-deny — unpinned by any
 * shipped scenario, exercised by real traffic. Exactly the blind spot.
 */
const divergeYaml = `rules:
  - id: never_emit_credit_card
    when:
      output_matches_regex: '\\b(?:\\d[ -]*?){13,19}\\b'
    effect: deny
    reason: PII guard
  - id: destructive_runbook_requires_admin_approval
    when:
      runbook_destructive: true
      tools_in: [execute_runbook_script]
    effect: require_approval
    approver_role: admin
    approver_count: 2
    timeout_seconds: 300
    on_timeout: deny
    reason: destructive runbooks require 2 admin signatures
  - id: read_only_default_allow
    when:
      tools_in: [query_logs, jira_get_issue]
    effect: allow
    reason: read-only ops are default-allowed
  - id: non_destructive_default_allow
    when:
      tools_in: [jira_create_issue, execute_runbook_script, invoke_human_on_slack, meeting_interrupt]
    effect: allow
    reason: non-destructive ops are default-allowed
`;

let dir: string;
let eventsDir: string;
let log: JsonlFileEventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shadow-replay-'));
  eventsDir = join(dir, 'events');
  log = new JsonlFileEventLog({ baseDir: eventsDir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type GovEvent = Extract<DecisionEvent, { kind: 'governance' }>;

const intent = (ts: number): IntentEnvelope => ({
  intent: { kind: 'meeting_response', subKind: 'question' },
  confidence: 1,
  entities: {},
  rawContext: { source: 'meeting', ts, payload: {} },
});

const govt = (
  cid: string,
  ts: number,
  tool: NonNullable<GovEvent['action']>['tool'],
  effect: Decision['effect'],
  withAction = true,
  args: Record<string, unknown> = { query_string: 'x' },
): GovEvent =>
  ({
    correlationId: cid,
    ts,
    layer: 'governance',
    source: 'internal',
    kind: 'governance',
    intent: intent(ts),
    ...(withAction ? { action: { tool, args } } : {}),
    decision: { effect, reason: 'r', policyIds: ['p1'] },
  }) as GovEvent;
describe('ShadowReplay', () => {
  it('finds zero divergences when the candidate IS the live bundle', async () => {
    await log.append(govt('cid-1', 1_000, 'query_logs', 'allow'));
    // Truthful recorded deny on a REAL tool: the live bundle's PII rule
    // denies card-shaped args regardless of tool (delete_database exists
    // only in eval scenarios, not in the ToolName union).
    await log.append(govt('cid-2', 2_000, 'query_logs', 'deny', true, { query_string: 'card 4111 1111 1111 1111' }));
    const live = new PolicyEngine({ yaml: defaultYaml });
    const r = await new ShadowReplay({ eventLog: log, engine: live }).run();
    expect(r.divergences).toEqual([]);
    expect(r.replayed).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.inspected).toBe(2);
  });

  it('reports a divergence with cid, ts, tool, and both effects', async () => {
    // query_evidence: the live bundle allows it (read_only_default_allow);
    // the candidate narrows read-only → default-deny. A real divergence.
    await log.append(govt('cid-1', 1_000, 'query_evidence', 'allow'));
    const candidate = new PolicyEngine({ yaml: divergeYaml });
    const r = await new ShadowReplay({ eventLog: log, engine: candidate }).run();
    expect(r.divergences).toEqual([
      { correlationId: 'cid-1', ts: 1_000, tool: 'query_evidence', recorded: 'allow', candidate: 'deny' },
    ]);
    expect(r.replayed).toBe(1);
  });

  it('replays the FIRST governance event per correlationId only (blast escalation never double-counts)', async () => {
    await log.append(govt('cid-1', 1_000, 'query_evidence', 'allow'));
    // The dispatch's blast-escalation re-audit: same cid, same tool, DIFFERENT
    // live effect. Replaying it would report a divergence that is platform
    // escalation, not policy.
    await log.append(govt('cid-1', 1_100, 'query_evidence', 'require_approval'));
    const candidate = new PolicyEngine({ yaml: divergeYaml });
    const r = await new ShadowReplay({ eventLog: log, engine: candidate }).run();
    expect(r.inspected).toBe(2);
    expect(r.replayed).toBe(1); // first event only
    expect(r.skipped).toBe(1); // the escalation re-audit
    expect(r.divergences).toEqual([
      { correlationId: 'cid-1', ts: 1_000, tool: 'query_evidence', recorded: 'allow', candidate: 'deny' },
    ]);
  });

  it('counts legacy action-less events as skipped, never fatal', async () => {
    await log.append(govt('cid-legacy', 1_000, 'query_logs', 'allow', false));
    await log.append(govt('cid-new', 2_000, 'query_logs', 'allow'));
    const r = await new ShadowReplay({ eventLog: log, engine: new PolicyEngine({ yaml: divergeYaml }) }).run();
    expect(r.inspected).toBe(2);
    expect(r.replayed).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.divergences).toEqual([]);
  });

  it('honors the from/to window (default-window source: bundlePromotedAt)', async () => {
    await log.append(govt('cid-old', 1_000, 'query_logs', 'allow'));
    await log.append(govt('cid-mid', 2_000, 'query_logs', 'allow'));
    await log.append(govt('cid-new', 3_000, 'query_logs', 'allow'));
    const r = await new ShadowReplay({ eventLog: log, engine: new PolicyEngine({ yaml: defaultYaml }) }).run({ from: 1_500, to: 2_500 });
    expect(r.replayed).toBe(1); // only cid-mid is inside [1500, 2500)
    expect(r.window).toEqual({ from: 1_500, to: 2_500, reason: 'explicit window' });
    // promotedAt path: inclusive lower bound — traffic since the live bundle
    // was promoted votes; older traffic does not.
    const rp = await new ShadowReplay({ eventLog: log, engine: new PolicyEngine({ yaml: defaultYaml }) }).run({ bundlePromotedAt: 2_000 });
    expect(rp.replayed).toBe(2); // cid-mid (ts 2000, inclusive) + cid-new
    expect(rp.window.reason).toBe('since current bundle promotion');
  });

  it('treats an empty spine as zero replays, green', async () => {
    const r = await new ShadowReplay({ eventLog: log, engine: new PolicyEngine({ yaml: divergeYaml }) }).run();
    expect(r).toEqual({
      inspected: 0,
      replayed: 0,
      skipped: 0,
      window: { reason: 'full log (no window and no promotedAt)' },
      divergences: [],
    });
  });

  it('fails closed on a corrupt spine line (never silently replays half the traffic)', async () => {
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(join(eventsDir, '2026-09-13.jsonl'), '{not json}\n', 'utf8');
    const r = await new ShadowReplay({ eventLog: log, engine: new PolicyEngine({ yaml: defaultYaml }) }).run();
    expect(r.replayed).toBe(0);
    expect(r.divergences).toEqual([]);
  });
});



/* --------------------- PromotionGate integration --------------------- */

describe('ShadowReplay through the PromotionGate', () => {
  const suggestion: PolicySuggestion = {
    id: 's-shadow',
    rationale: 'test: narrow read-only allow to the two pinned tools',
    evidence: { outcomeIds: [], sampleSize: 3, confidence: 0.9 },
    proposedChange: { type: 'modify_rule', ruleId: 'read_only_default_allow', patch: { when: { tools_in: ['query_logs', 'jira_get_issue'] } } },
    risk: 'medium',
    estimatedImpact: { outcomeMetric: 'none', expectedDelta: '0' },
  };

  let dir: string;
  let store: PolicyStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-gate-'));
    // Injectable clock pins the promotion stamp: the replay window starts at
    // 5_000, so events recorded after it vote, events before it do not.
    store = new PolicyStore({ dbPath: join(dir, 'p.db'), yamlDir: join(dir, 'bundles'), now: () => 5_000 });
    const v1 = await store.save({ yaml: defaultYaml, authoredBy: 'alice', signedBy: 'alice' });
    await store.promote(v1.version, { promotedBy: ['admin1', 'admin2'], evalRunId: 'e1', safetyNetPassed: true });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeGate = () =>
    new PromotionGate({
      store,
      safetyNet: new SafetyNet({}),
      evalScenariosPath,
      safetyNetScenariosPath,
      eventLog: log,
      shadowReplay: new ShadowReplay({ eventLog: log, engine: new PolicyEngine({ yaml: defaultYaml }) }),
    });

  it('refuses a candidate that diverges on recorded traffic — even though it passes every handwritten scenario', async () => {
    // Post-promotion traffic the live bundle allowed: a query_evidence call.
    // The candidate narrows read-only to two tools → this becomes default-deny.
    await log.append(govt('cid-live', 6_000, 'query_evidence', 'allow'));
    await expect(makeGate().promote(suggestion, ['admin1', 'admin2'])).rejects.toThrow(/Shadow replay failed/);
    // Store unchanged — the regression never landed.
    expect(store.current().version).toBe(1);
  });

  it('does not let pre-promotion traffic vote on the candidate', async () => {
    // Same divergent request shape, but recorded BEFORE the current bundle
    // was promoted: it was decided by an OLDER bundle, so it cannot block.
    await log.append(govt('cid-old', 1_000, 'jira_get_issue', 'allow'));
    const v2 = await makeGate().promote(suggestion, ['admin1', 'admin2']);
    expect(v2.version).toBe(2);
    // The patch landed: the candidate bundle now default-denies an unpinned
    // read-only tool (style-independent behavioral assertion).
    const promoted = new PolicyEngine({ yaml: store.current().yaml });
    expect(promoted.evaluate(intent(7_000), { tool: 'query_evidence', args: {} }).effect).toBe('deny');
  });

  it('promotes cleanly when the candidate agrees with all recorded traffic', async () => {
    await log.append(govt('cid-1', 6_000, 'query_logs', 'allow'));
    await log.append(govt('cid-2', 6_100, 'jira_get_issue', 'allow'));
    const v2 = await makeGate().promote(suggestion, ['admin1', 'admin2']);
    expect(v2.version).toBe(2);
  });

  it('stays promotion-neutral when unwired (back-compat)', async () => {
    await log.append(govt('cid-live', 6_000, 'jira_get_issue', 'allow'));
    const gate = new PromotionGate({
      store,
      safetyNet: new SafetyNet({}),
      evalScenariosPath,
      safetyNetScenariosPath,
      eventLog: log,
    });
    const v2 = await gate.promote(suggestion, ['admin1', 'admin2']);
    expect(v2.version).toBe(2);
  });
});

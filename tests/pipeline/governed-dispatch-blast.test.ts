/**
 * GovernedDispatch — risk-aware approval escalation (ADR-0007 enforced).
 *
 * When a ServiceTopology is wired and the action's tool/args resolve to a
 * known (service, action) pair, the topology's assessment is authoritative:
 *  - `allow` + medium/critical → escalated to a staged approval (audited as
 *    a second governance event with the blast-carrying decision);
 *  - `require_approval` keeps its semantics but the gate gains the blast
 *    signature floor;
 *  - executing an approved critical-risk action outside the maintenance
 *    window is refused (fail-closed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernedDispatch } from '../../src/pipeline/governed-dispatch';
import type { GovernedDispatchOptions, GovernedRunInput } from '../../src/pipeline/governed-dispatch';
import type { IntentEnvelope, DecisionEvent } from '../../src/event-log/types';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { Decision, ProposedAction } from '../../src/governance/decision';
import { MaintenanceWindowError } from '../../src/governance/maintenance-window';
import { ServiceTopology } from '../../src/topology/blast';

let dir: string;
let eventsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'governed-dispatch-blast-'));
  eventsDir = join(dir, 'events');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------- doubles ------------------------------- */

const ENVELOPE: IntentEnvelope = {
  intent: { kind: 'meeting_response', subKind: 'question' },
  confidence: 1,
  entities: { speakerId: 'u1' },
  rawContext: { source: 'meeting', ts: 1_000_000, payload: {} },
};

const decision = (effect: Decision['effect'], reason = 'because', policyIds = ['p1']): Decision => ({
  effect,
  reason,
  policyIds,
});

const runInput = (overrides: Partial<GovernedRunInput> = {}): GovernedRunInput => ({
  cid: '1f4-00000001',
  speakerId: 'u1',
  envelope: ENVELOPE,
  action: { tool: 'execute_runbook_script', args: { script_name: 'failover-db-primary' } },
  ...overrides,
});

function fakePolicy(byTool: Partial<Record<string, Decision>>, trace: string[]) {
  const evaluated: string[] = [];
  const policyEngine = {
    evaluate: (_envelope: unknown, action: ProposedAction) => {
      evaluated.push(action.tool);
      trace.push(`policy:${action.tool}`);
      return byTool[action.tool] ?? decision('allow', 'no rule matched (fake)');
    },
  };
  return { policyEngine: policyEngine as unknown as GovernedDispatchOptions['policyEngine'], evaluated };
}

function fakeSafetyNet(trace: string[]) {
  const checked: string[] = [];
  const safetyNet = {
    runAll: (input: { tool: string }) => {
      checked.push(input.tool);
      trace.push(`safety:${input.tool}`);
      return { vetoed: false, reasons: [] };
    },
  };
  return { safetyNet: safetyNet as unknown as GovernedDispatchOptions['safetyNet'], checked };
}

/** Toggle for the fake window — flipped inside individual tests. */
let OPEN_WINDOW = false;

function fakeGate(trace: string[]) {
  const requests: Array<{
    policyId: string;
    decision: Decision;
    action: ProposedAction;
    blastAssessment?: { risk?: string };
    thread?: { channel: string; ts: string };
  }> = [];
  const status = new Map<string, 'pending' | 'granted' | 'denied' | 'executed'>();
  const required = new Map<string, number>();
  const blasts = new Map<string, { risk?: string } | undefined>();
  let counter = 0;
  const gate = {
    request: async (input: { policyId: string; decision: Decision; action: ProposedAction; blastAssessment?: { risk?: string }; thread?: { channel: string; ts: string } }) => {
      const id = `ap-${++counter}`;
      trace.push(`gate:${input.policyId}`);
      requests.push({ policyId: input.policyId, decision: input.decision, action: input.action, blastAssessment: input.blastAssessment, thread: input.thread });
      status.set(id, 'pending');
      required.set(id, input.blastAssessment ? (input.blastAssessment.risk === 'critical' ? 2 : 1) : 2);
      blasts.set(id, input.blastAssessment);
      return { approvalId: id };
    },
    status: (id: string) => (status.has(id) ? { status: status.get(id) } : undefined),
    markExecuted: (id: string) => {
      if (status.get(id) === 'granted') status.set(id, 'executed');
      return { status: status.get(id) };
    },
    assertExecutable: (id: string) => {
      // Mirrors the real gate: refuse critical risk while the window is
      // closed (same error type the dispatch converts to a refusal); the
      // dispatch has already verified status === granted.
      if (blasts.get(id)?.risk === 'critical' && !OPEN_WINDOW) throw new MaintenanceWindowError('maintenance window closed');
      return { status: status.get(id) };
    },
  };
  return {
    approvals: gate as unknown as GovernedDispatchOptions['approvals'],
    requests,
    grantN: (id: string, n: number) => {
      if ((required.get(id) ?? 1) <= n) status.set(id, 'granted');
    },
  };
}

function fakeSupervisor(trace: string[]) {
  const runs: Array<{ governed: unknown; cid: string }> = [];
  const supervisor = {
    run: async (input: { governed: unknown; context: { correlationId: string } }) => {
      const tool = (input.governed as { action?: { tool?: string } }).action?.tool ?? '?';
      trace.push(`supervisor:${tool}`);
      runs.push({ governed: input.governed, cid: input.context.correlationId });
      return { ok: true, reason: undefined };
    },
  };
  return { supervisor: supervisor as unknown as GovernedDispatchOptions['supervisor'], runs };
}

function fakeAssembler() {
  const calls: number[] = [];
  const assembler = {
    assemble: async () => {
      calls.push(1);
      return { marker: 'assembled' };
    },
  };
  return { assembler: assembler as unknown as GovernedDispatchOptions['assembler'], calls };
}

function fakeRecorder() {
  const recorded: string[] = [];
  const outcomeRecorder = {
    record: async (cid: string) => {
      recorded.push(cid);
    },
  } as unknown as GovernedDispatchOptions['outcomeRecorder'];
  return { outcomeRecorder, recorded };
}

interface DispatchParts {
  dispatch: GovernedDispatch;
  eventLog: JsonlFileEventLog;
  trace: string[];
  requests: ReturnType<typeof fakeGate>['requests'];
  grantN: (id: string, n: number) => void;
  runs: ReturnType<typeof fakeSupervisor>['runs'];
  recorded: string[];
}

const CRITICAL_TOPO = new ServiceTopology();
CRITICAL_TOPO.upsert('db-primary', []);
const MEDIUM_TOPO = new ServiceTopology();
MEDIUM_TOPO.upsert('checkout-service', ['payment-service']);

function build(opts: {
  policy?: Partial<Record<string, Decision>>;
  topology?: ServiceTopology;
  windowOpen?: boolean;
} = {}): DispatchParts {
  OPEN_WINDOW = opts.windowOpen ?? false;
  const eventLog = new JsonlFileEventLog({ baseDir: eventsDir });
  const trace: string[] = [];
  const policy = fakePolicy(opts.policy ?? {}, trace);
  const safety = fakeSafetyNet(trace);
  const gate = fakeGate(trace);
  const sup = fakeSupervisor(trace);
  const asm = fakeAssembler();
  const rec = fakeRecorder();
  const dispatch = new GovernedDispatch({
    policyEngine: policy.policyEngine,
    safetyNet: safety.safetyNet,
    approvals: gate.approvals,
    supervisor: sup.supervisor,
    assembler: asm.assembler,
    eventLog,
    outcomeRecorder: rec.outcomeRecorder,
    ...(opts.topology ? { topology: opts.topology } : {}),
    now: () => 1_000_000,
  });
  return {
    dispatch,
    eventLog,
    trace,
    requests: gate.requests,
    grantN: gate.grantN,
    runs: sup.runs,
    recorded: rec.recorded,
  };
}

const eventsFor = async (log: JsonlFileEventLog, cid: string): Promise<DecisionEvent[]> => {
  const out: DecisionEvent[] = [];
  for await (const e of log.query({ correlationId: cid })) out.push(e);
  return out;
};

/* ------------------------------ blast escalation ------------------------------ */

describe('GovernedDispatch risk-aware escalation', () => {
  it('allow + critical blast → escalated to a staged approval, audited, never auto-executed', async () => {
    const parts = build({ topology: CRITICAL_TOPO });
    const outcome = await parts.dispatch.run(runInput());
    expect(outcome.kind).toBe('staged');
    expect(outcome.routing.approvalStatus).toBe('pending');
    expect(parts.runs).toHaveLength(0); // nothing auto-executed
    expect(parts.requests[0]?.blastAssessment).toBeDefined();
    expect(parts.requests[0]?.blastAssessment?.risk).toBe('critical');
    // The escalation is audited: the original allow decision AND the
    // escalated decision both hit the spine for this cid.
    const governanceEvents = (await eventsFor(parts.eventLog, '1f4-00000001')).filter((e) => e.kind === 'governance');
    expect(governanceEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('allow + medium blast → staged with the assessment attached', async () => {
    const parts = build({ topology: MEDIUM_TOPO });
    const outcome = await parts.dispatch.run(runInput({ action: { tool: 'execute_runbook_script', args: { script_name: 'restart-checkout-service' } } }));
    expect(outcome.kind).toBe('staged');
    expect(parts.requests[0]?.blastAssessment?.risk).toBe('medium');
    expect(parts.runs).toHaveLength(0);
  });

  it('allow + low risk → executes immediately (no escalation)', async () => {
    const topo = new ServiceTopology();
    topo.upsert('leaf-service', []);
    const parts = build({ topology: topo });
    const outcome = await parts.dispatch.run(runInput({ action: { tool: 'execute_runbook_script', args: { script_name: 'restart-leaf-service' } } }));
    expect(outcome.kind).toBe('executed');
    expect(parts.requests).toHaveLength(0);
  });

  it('require_approval passes the assessment so the gate raises its signature floor', async () => {
    const parts = build({ topology: CRITICAL_TOPO, policy: { execute_runbook_script: decision('require_approval', 'destructive') } });
    const outcome = await parts.dispatch.run(runInput());
    expect(outcome.kind).toBe('staged');
    expect(parts.requests[0]?.blastAssessment?.risk).toBe('critical');
  });

  it('unwired topology → allow executes without any blast gating (honest no-op)', async () => {
    const parts = build({});
    const outcome = await parts.dispatch.run(runInput());
    expect(outcome.kind).toBe('executed');
    expect(parts.requests).toHaveLength(0);
  });

  it('unknown service or verbless script → no assessment, allow executes', async () => {
    const parts = build({ topology: CRITICAL_TOPO });
    const outcome = await parts.dispatch.run(runInput({ action: { tool: 'execute_runbook_script', args: { script_name: 'clear-cache' } } }));
    expect(outcome.kind).toBe('executed');
    expect(parts.requests).toHaveLength(0);
  });

  it('approved critical action is REFUSED outside the maintenance window, executes inside it', async () => {
    const parts = build({ topology: CRITICAL_TOPO });
    const outcome = await parts.dispatch.run(runInput());
    const approvalId = outcome.routing.approvalId as string;
    parts.grantN(approvalId, 2); // critical needs 2 signatures — fully granted

    OPEN_WINDOW = false;
    const outside = await parts.dispatch.executeApproved(approvalId, 'host-cid');
    expect(outside.ok).toBe(false);
    expect(outside.reason).toContain('maintenance window');
    expect(parts.runs).toHaveLength(0);

    OPEN_WINDOW = true;
    const inside = await parts.dispatch.executeApproved(approvalId, 'host-cid');
    expect(inside.ok).toBe(true);
    expect(parts.runs).toHaveLength(1);
  });
});

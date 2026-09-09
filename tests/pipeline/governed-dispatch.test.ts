/**
 * Direct unit tests for GovernedDispatch — the single governance →
 * execution path (spec §5).
 *
 * Unlike the pipeline integration tests, these drive the dispatch in
 * isolation with typed doubles for its collaborators (policy engine,
 * SafetyNet, approval gate, supervisor, assembler, recorder) while the
 * event spine stays REAL — so audit-trail assertions query actual emitted
 * events. The pinned invariants:
 *
 *  - Safety-veto precedence: a veto halts BEFORE any policy effect can act
 *    (allow, deny, or require_approval) and emits governance + safety_net.
 *  - Deny ordering: the policy decision is audited, then the dispatch halts
 *    without staging an approval or touching the supervisor.
 *  - Approval staging: require_approval requests through the gate, stages
 *    action+decision keyed by approvalId; executeApproved only fires on a
 *    granted status and re-dispatches the ORIGINAL action and cid.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernedDispatch, recentEvents } from '../../src/pipeline/governed-dispatch';
import type { GovernedDispatchOptions, GovernedRunInput } from '../../src/pipeline/governed-dispatch';
import type { IntentEnvelope, DecisionEvent } from '../../src/event-log/types';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { ContextBundle } from '../../src/understanding/context-assembler';
import type { Decision, ProposedAction } from '../../src/governance/decision';

let dir: string;
let eventsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'governed-dispatch-'));
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

const LOG_QUERY: ProposedAction = { tool: 'query_logs', args: { query_string: 'errors' } };
const DESTRUCTIVE: ProposedAction = { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } };
const BUNDLE = { marker: 'ingress-bundle' } as unknown as ContextBundle;

const decision = (effect: Decision['effect'], reason = 'because', policyIds = ['p1']): Decision => ({
  effect,
  reason,
  policyIds,
});

const runInput = (overrides: Partial<GovernedRunInput> = {}): GovernedRunInput => ({
  cid: '1f4-00000001',
  speakerId: 'u1',
  envelope: ENVELOPE,
  action: LOG_QUERY,
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

function fakeSafetyNet(vetoTools: ReadonlySet<string>, trace: string[]) {
  const checked: string[] = [];
  const safetyNet = {
    runAll: (input: { tool: string }) => {
      checked.push(input.tool);
      trace.push(`safety:${input.tool}`);
      return vetoTools.has(input.tool)
        ? { vetoed: true, reasons: ['rbac: guests may not run destructive tools'] }
        : { vetoed: false, reasons: [] };
    },
  };
  return { safetyNet: safetyNet as unknown as GovernedDispatchOptions['safetyNet'], checked };
}

function fakeGate(trace: string[]) {
  const requests: Array<{
    policyId: string;
    decision: Decision;
    action: ProposedAction;
    thread?: { channel: string; ts: string };
  }> = [];
  const status = new Map<string, 'pending' | 'granted' | 'denied' | 'executed'>();
  let counter = 0;
  const gate = {
    request: async (input: {
      policyId: string;
      decision: Decision;
      action: ProposedAction;
      thread?: { channel: string; ts: string };
    }) => {
      const id = `ap-${++counter}`;
      trace.push(`gate:${input.policyId}`);
      requests.push({ policyId: input.policyId, decision: input.decision, action: input.action, thread: input.thread });
      status.set(id, 'pending');
      return { approvalId: id };
    },
    status: (id: string) => (status.has(id) ? { status: status.get(id) } : undefined),
    markExecuted: (id: string) => {
      if (status.get(id) === 'granted') status.set(id, 'executed');
      return { status: status.get(id) };
    },
  };
  return {
    approvals: gate as unknown as GovernedDispatchOptions['approvals'],
    requests,
    grant: (id: string) => status.set(id, 'granted'),
    deny: (id: string) => status.set(id, 'denied'),
  };
}

function fakeSupervisor(trace: string[]) {
  const runs: Array<{ governed: unknown; cid: string; speakerId: string; bundle: unknown }> = [];
  const state = { next: { ok: true, reason: undefined as string | undefined } };
  const supervisor = {
    run: async (input: { governed: unknown; context: { correlationId: string; speakerId: string }; bundle: unknown }) => {
      const tool = (input.governed as { action?: { tool?: string } }).action?.tool ?? '?';
      trace.push(`supervisor:${tool}`);
      runs.push({ governed: input.governed, cid: input.context.correlationId, speakerId: input.context.speakerId, bundle: input.bundle });
      return state.next;
    },
  };
  return { supervisor: supervisor as unknown as GovernedDispatchOptions['supervisor'], runs, state };
}

function fakeAssembler() {
  const calls: Array<{ envelope: unknown; scope: string | undefined }> = [];
  const assembler = {
    assemble: async (input: { envelope: unknown; scope?: string }) => {
      calls.push({ envelope: input.envelope, scope: input.scope });
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
  /** One ordered line per collaborator touch — the dispatch's control flow. */
  trace: string[];
  evaluated: string[];
  checked: string[];
  requests: ReturnType<typeof fakeGate>['requests'];
  grant: (id: string) => void;
  deny: (id: string) => void;
  runs: ReturnType<typeof fakeSupervisor>['runs'];
  supervisorState: ReturnType<typeof fakeSupervisor>['state'];
  assemblerCalls: ReturnType<typeof fakeAssembler>['calls'];
  recorded: string[];
}

function build(opts: { policy?: Partial<Record<string, Decision>>; veto?: ReadonlySet<string> } = {}): DispatchParts {
  const eventLog = new JsonlFileEventLog({ baseDir: eventsDir });
  const trace: string[] = [];
  const policy = fakePolicy(opts.policy ?? {}, trace);
  const safety = fakeSafetyNet(opts.veto ?? new Set(), trace);
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
    now: () => 1_000_000,
  });
  return {
    dispatch,
    eventLog,
    trace,
    evaluated: policy.evaluated,
    checked: safety.checked,
    requests: gate.requests,
    grant: gate.grant,
    deny: gate.deny,
    runs: sup.runs,
    supervisorState: sup.state,
    assemblerCalls: asm.calls,
    recorded: rec.recorded,
  };
}

const eventsFor = async (log: JsonlFileEventLog, cid: string): Promise<DecisionEvent[]> => {
  const out: DecisionEvent[] = [];
  for await (const e of log.query({ correlationId: cid })) out.push(e);
  return out;
};

/* ------------------------------ approval staging ------------------------------ */

describe('GovernedDispatch approval staging', () => {
  it('stages a require_approval decision through the gate and reports pending', async () => {
    const parts = build({
      policy: { execute_runbook_script: decision('require_approval', 'destructive', ['p-destructive']) },
    });
    const outcome = await parts.dispatch.run(runInput({ action: DESTRUCTIVE, thread: { channel: 'C1', ts: '1' } }));

    expect(outcome.kind).toBe('staged');
    expect(outcome.routing.routed).toBe('pipeline');
    expect(outcome.routing.approvalStatus).toBe('pending');
    expect(outcome.routing.approvalId).toBeDefined();

    // The gate request carries the policy decision, the action, and the thread.
    expect(parts.requests).toHaveLength(1);
    expect(parts.requests[0]?.policyId).toBe('p-destructive');
    expect(parts.requests[0]?.decision.effect).toBe('require_approval');
    expect(parts.requests[0]?.action).toEqual(DESTRUCTIVE);
    expect(parts.requests[0]?.thread).toEqual({ channel: 'C1', ts: '1' });

    // Nothing executed, nothing recorded — the action waits for the grant.
    expect(parts.runs).toHaveLength(0);
    expect(parts.recorded).toHaveLength(0);
    // Control flow: policy → safety → gate (no supervisor hop).
    expect(parts.trace).toEqual(['policy:execute_runbook_script', 'safety:execute_runbook_script', 'gate:p-destructive']);
  });

  it('executeApproved refuses before the grant, then re-dispatches the ORIGINAL action and cid after it', async () => {
    const parts = build({ policy: { execute_runbook_script: decision('require_approval', 'destructive') } });
    const outcome = await parts.dispatch.run(runInput({ cid: '1f4-00000077', action: DESTRUCTIVE }));
    const approvalId = outcome.routing.approvalId as string;

    const before = await parts.dispatch.executeApproved(approvalId, 'host-cid');
    expect(before.ok).toBe(false);
    expect(before.reason).toContain('pending');
    expect(parts.runs).toHaveLength(0);
    expect(parts.recorded).toHaveLength(0);

    parts.grant(approvalId);
    const after = await parts.dispatch.executeApproved(approvalId, 'host-cid');
    expect(after.ok).toBe(true);

    // The re-dispatch runs the staged action under the ORIGINAL correlation
    // id (audit joins), with the gate-minted 'approver' identity.
    expect(parts.runs).toHaveLength(1);
    expect(parts.runs[0]?.cid).toBe('1f4-00000077');
    expect(parts.runs[0]?.speakerId).toBe('approver');
    expect(parts.runs[0]?.governed).toMatchObject({ kind: 'execute', action: DESTRUCTIVE });
    expect(parts.recorded).toEqual(['1f4-00000077']);
  });

  it('a denied approval cannot be executed', async () => {
    const parts = build({ policy: { execute_runbook_script: decision('require_approval', 'destructive') } });
    const outcome = await parts.dispatch.run(runInput({ action: DESTRUCTIVE }));
    const approvalId = outcome.routing.approvalId as string;
    parts.deny(approvalId);

    const r = await parts.dispatch.executeApproved(approvalId, 'host-cid');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('denied');
    expect(parts.runs).toHaveLength(0);
    expect(parts.recorded).toHaveLength(0);
  });

  it('an unknown approvalId fails without consulting the gate or supervisor', async () => {
    const parts = build();
    const r = await parts.dispatch.executeApproved('nope', 'host-cid');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unknown approvalId');
    expect(parts.runs).toHaveLength(0);
  });
});

/* ------------------------------ deny ordering ------------------------------ */

describe('GovernedDispatch deny ordering', () => {
  it('policy deny is audited, then halts with no staging, execution, or outcome', async () => {
    const parts = build({ policy: { query_logs: decision('deny', 'not allowed for guests', ['p-deny']) } });
    const outcome = await parts.dispatch.run(runInput());

    expect(outcome.kind).toBe('halted');
    expect(outcome.routing.ok).toBe(false);
    expect(outcome.routing.reason).toBe('denied: not allowed for guests');
    expect(parts.evaluated).toEqual(['query_logs']);
    expect(parts.requests).toHaveLength(0);
    expect(parts.runs).toHaveLength(0);
    expect(parts.recorded).toHaveLength(0);

    // Exactly one audit event: the governance decision (with the always-on
    // SafetyNet marker the invariant requires).
    const events = await eventsFor(parts.eventLog, '1f4-00000001');
    expect(events.map((e) => e.kind)).toEqual(['governance']);
    const gov = events[0] as unknown as { decision: Decision };
    expect(gov?.decision).toMatchObject({
      effect: 'deny',
      reason: 'not allowed for guests',
      unconditionalSafetyNetCheck: true,
    });
  });

  it('allow executes through the supervisor and records the outcome (policy → safety → supervisor)', async () => {
    const parts = build({ policy: { query_logs: decision('allow', 'read-only', ['p-allow']) } });
    const outcome = await parts.dispatch.run(runInput());

    expect(outcome.kind).toBe('executed');
    expect(outcome.routing.ok).toBe(true);
    expect(parts.runs).toHaveLength(1);
    expect(parts.runs[0]?.governed).toMatchObject({ kind: 'execute', action: LOG_QUERY });
    expect(parts.recorded).toEqual(['1f4-00000001']);
    expect(parts.trace).toEqual(['policy:query_logs', 'safety:query_logs', 'supervisor:query_logs']);
  });

  it('a supervisor failure is reported honestly (kind executed, ok false) and still recorded', async () => {
    const parts = build();
    parts.supervisorState.next = { ok: false, reason: 'hop cap reached' };
    const outcome = await parts.dispatch.run(runInput());

    expect(outcome.kind).toBe('executed');
    expect(outcome.routing.ok).toBe(false);
    expect(outcome.routing.reason).toBe('hop cap reached');
    expect(parts.recorded).toEqual(['1f4-00000001']);
  });
});

/* --------------------------- safety-veto precedence --------------------------- */

describe('GovernedDispatch safety-veto precedence', () => {
  it('a veto halts before an ALLOW can execute', async () => {
    const parts = build({
      policy: { execute_runbook_script: decision('allow', 'allow-all rule') },
      veto: new Set(['execute_runbook_script']),
    });
    const outcome = await parts.dispatch.run(runInput({ action: DESTRUCTIVE, speakerId: 'guest1' }));

    expect(outcome.kind).toBe('halted');
    expect(outcome.routing.ok).toBe(false);
    expect(outcome.routing.reason).toContain('SafetyNet veto');
    expect(outcome.routing.reason).toContain('rbac');
    expect(parts.runs).toHaveLength(0);
    expect(parts.recorded).toHaveLength(0);
  });

  it('a veto beats require_approval: nothing is staged', async () => {
    const parts = build({
      policy: { execute_runbook_script: decision('require_approval', 'destructive') },
      veto: new Set(['execute_runbook_script']),
    });
    const outcome = await parts.dispatch.run(runInput({ action: DESTRUCTIVE, speakerId: 'guest1' }));

    expect(outcome.kind).toBe('halted');
    expect(parts.requests).toHaveLength(0);
    expect(outcome.routing.approvalId).toBeUndefined();
    expect(parts.trace).toEqual(['policy:execute_runbook_script', 'safety:execute_runbook_script']);
  });

  it('a veto beats deny: the veto reason wins', async () => {
    const parts = build({
      policy: { query_logs: decision('deny', 'policy says no') },
      veto: new Set(['query_logs']),
    });
    const outcome = await parts.dispatch.run(runInput());

    expect(outcome.kind).toBe('halted');
    expect(outcome.routing.reason).toContain('SafetyNet veto');
    expect(outcome.routing.reason).not.toContain('denied');
  });

  it('a veto still emits governance (with the policy decision) AND a safety_net event', async () => {
    const parts = build({
      policy: { query_logs: decision('deny', 'policy says no') },
      veto: new Set(['query_logs']),
    });
    await parts.dispatch.run(runInput());

    const events = await eventsFor(parts.eventLog, '1f4-00000001');
    expect(events.map((e) => e.kind)).toEqual(['governance', 'safety_net']);
    const gov = events[0] as unknown as { decision: Decision };
    expect(gov?.decision.effect).toBe('deny');
    expect(gov?.decision.unconditionalSafetyNetCheck).toBe(true);
    const veto = events[1] as unknown as { vetoed: boolean; check: string };
    expect(veto?.vetoed).toBe(true);
    expect(veto?.check).toBe('runAll');
  });
});

/* ------------------------------ context assembly ------------------------------ */

describe('GovernedDispatch context assembly', () => {
  it('assembles cross-scope context itself when the ingress passes no bundle', async () => {
    const parts = build();
    await parts.dispatch.run(runInput());
    expect(parts.assemblerCalls).toHaveLength(1);
    expect(parts.assemblerCalls[0]?.scope).toBeUndefined();
    expect((parts.runs[0]?.bundle as { marker?: string } | undefined)?.marker).toBe('assembled');
  });

  it('passes the ingress-provided bundle through by identity and skips assembly', async () => {
    const parts = build();
    await parts.dispatch.run(runInput({ bundle: BUNDLE }));
    expect(parts.assemblerCalls).toHaveLength(0);
    expect(parts.runs[0]?.bundle).toBe(BUNDLE);
  });
});

/* ------------------------------ recentEvents ------------------------------ */

describe('recentEvents', () => {
  it('returns events inside the 60s window, capped at 10', async () => {
    const log = new JsonlFileEventLog({ baseDir: eventsDir });
    const base = {
      layer: 'governance' as const,
      source: 'internal' as const,
      kind: 'governance' as const,
      intent: ENVELOPE,
      decision: decision('allow'),
    };
    for (let i = 0; i < 12; i++) {
      await log.append({ correlationId: `c-${i}`, ts: 950_000 + i, ...base });
    }
    await log.append({ correlationId: 'too-old', ts: 900_000, ...base });

    const events = await recentEvents(log, () => 1_000_000);
    // 12 in-window events → capped at 10; the 900_000 event is outside the
    // 940_000 cutoff and never appears.
    expect(events).toHaveLength(10);
    expect(events.every((e) => e.ts >= 940_000)).toBe(true);
  });
});

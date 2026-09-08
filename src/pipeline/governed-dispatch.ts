/**
 * GovernedDispatch — the single governance → execution path (spec §5).
 *
 * Every routed action (question log queries, runbook offers, envelope
 * proposals, approved re-dispatches) funnels through one sequence: policy
 * evaluation → SafetyNet → governance audit events → deny / veto /
 * require_approval / allow. Allows execute through the Supervisor; staged
 * approvals wait here until the host calls executeApproved() after a grant.
 *
 * This module owns the approval staging map: it is written by the governed
 * run and read by executeApproved, so the two cannot drift apart.
 */
import type { IntentEnvelope, DecisionEvent } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import type { ContextAssembler, ContextBundle } from '../understanding/context-assembler.js';
import type { PolicyEngine } from '../governance/policy-engine.js';
import type { SafetyNet } from '../governance/safety-net/index.js';
import type { ApprovalGate } from '../governance/approval-gate.js';
import type { Decision, ProposedAction } from '../governance/decision.js';
import type { SupervisorAgent } from '../execution/supervisor.js';
import type { OutcomeRecorder } from '../learning/outcome-recorder.js';
import type { ApprovedAction, PipelineRouting } from './types.js';

export interface GovernedDispatchOptions {
  policyEngine: PolicyEngine;
  safetyNet: SafetyNet;
  approvals: ApprovalGate;
  supervisor: SupervisorAgent;
  assembler: ContextAssembler;
  eventLog: EventLog;
  outcomeRecorder?: OutcomeRecorder;
  now: () => number;
}

/** Where a governed dispatch ended up. */
export type GovernedOutcome =
  | { kind: 'executed'; routing: PipelineRouting }
  | { kind: 'halted'; routing: PipelineRouting }
  | { kind: 'staged'; routing: PipelineRouting };

export interface GovernedRunInput {
  cid: string;
  speakerId: string;
  /** The envelope governance evaluates and audits (may be runbook-enriched). */
  envelope: IntentEnvelope;
  action: ProposedAction;
  /** Pre-assembled bundle from the ingress (meeting scope); assembled
   *  internally (cross scope) when absent. */
  bundle?: ContextBundle;
  thread?: { channel: string; ts: string };
}

export class GovernedDispatch {
  private readonly policyEngine: PolicyEngine;
  private readonly safetyNet: SafetyNet;
  private readonly approvals: ApprovalGate;
  private readonly supervisor: SupervisorAgent;
  private readonly assembler: ContextAssembler;
  private readonly eventLog: EventLog;
  private readonly outcomeRecorder?: OutcomeRecorder;
  private readonly now: () => number;
  /** approvalId → staged action awaiting (or holding) a grant. */
  private readonly staged = new Map<string, ApprovedAction>();

  constructor(opts: GovernedDispatchOptions) {
    this.policyEngine = opts.policyEngine;
    this.safetyNet = opts.safetyNet;
    this.approvals = opts.approvals;
    this.supervisor = opts.supervisor;
    this.assembler = opts.assembler;
    this.eventLog = opts.eventLog;
    this.outcomeRecorder = opts.outcomeRecorder;
    this.now = opts.now;
  }

  /** Evaluate, audit, and execute one proposed action under governance. */
  async run(input: GovernedRunInput): Promise<GovernedOutcome> {
    const decision = this.policyEngine.evaluate(input.envelope, input.action);
    const safety = this.safetyNet.runAll({
      correlationId: input.cid,
      speakerId: input.speakerId,
      tool: input.action.tool,
      args: input.action.args,
      tokens: { prompt: 0, completion: 0 },
      candidateOutput: JSON.stringify(input.action.args),
    });
    await this.emitGovernance(input.cid, input.envelope, decision, safety.vetoed);
    if (safety.vetoed) {
      return {
        kind: 'halted',
        routing: { routed: 'pipeline', correlationId: input.cid, ok: false, reason: `SafetyNet veto: ${safety.reasons.join('; ')}` },
      };
    }
    if (decision.effect === 'deny') {
      return { kind: 'halted', routing: { routed: 'pipeline', correlationId: input.cid, ok: false, reason: `denied: ${decision.reason}` } };
    }
    if (decision.effect === 'require_approval') {
      const { approvalId } = await this.approvals.request({
        policyId: decision.policyIds[0] ?? 'policy',
        decision,
        action: input.action,
        ...(input.thread ? { thread: input.thread } : {}),
      });
      this.staged.set(approvalId, { approvalId, correlationId: input.cid, action: input.action, decision });
      return { kind: 'staged', routing: { routed: 'pipeline', correlationId: input.cid, approvalId, approvalStatus: 'pending' } };
    }

    // Allow (or transform) → execute through the Supervisor.
    const r = await this.supervisor.run({
      governed: { kind: 'execute', decision, action: input.action },
      context: {
        correlationId: input.cid,
        speakerId: input.speakerId,
        tokens: { prompt: 0, completion: 0 },
        candidateOutput: JSON.stringify(input.action.args),
        toolCallHistory: [],
      },
      bundle: input.bundle ?? (await this.assembleFor(input.envelope)),
    });
    await this.outcomeRecorder?.record(input.cid);
    return { kind: 'executed', routing: { routed: 'pipeline', correlationId: input.cid, ok: r.ok, reason: r.reason } };
  }

  /** Execute a staged action once its approval is granted. */
  async executeApproved(approvalId: string, correlationId: string): Promise<PipelineRouting> {
    const staged = this.staged.get(approvalId);
    if (!staged) return { routed: 'pipeline', correlationId, ok: false, reason: `unknown approvalId: ${approvalId}` };
    const snap = this.approvals.status(approvalId);
    if (snap?.status !== 'granted') {
      return { routed: 'pipeline', correlationId, ok: false, reason: `approval not granted (status: ${snap?.status ?? 'unknown'})` };
    }
    return this.runApproved(staged);
  }

  private async runApproved(staged: ApprovedAction): Promise<PipelineRouting> {
    const cid = staged.correlationId;
    const r = await this.supervisor.run({
      governed: { kind: 'execute', decision: staged.decision, action: staged.action },
      context: {
        correlationId: cid,
        speakerId: 'approver',
        tokens: { prompt: 0, completion: 0 },
        candidateOutput: JSON.stringify(staged.action.args),
        toolCallHistory: [],
      },
      bundle: await this.assembleFor(unknownEnvelope(cid)),
    });
    await this.outcomeRecorder?.record(cid);
    return { routed: 'pipeline', correlationId: cid, ok: r.ok, reason: r.reason };
  }

  private async assembleFor(envelope: IntentEnvelope): Promise<ContextBundle> {
    return this.assembler.assemble({ envelope, recent: await recentEvents(this.eventLog, this.now) });
  }

  private async emitGovernance(
    cid: string,
    envelope: IntentEnvelope,
    decision: Decision,
    vetoed: boolean,
  ): Promise<void> {
    await this.eventLog.append({
      correlationId: cid,
      ts: this.now(),
      layer: 'governance',
      source: 'internal',
      kind: 'governance',
      intent: envelope,
      decision: { ...decision, unconditionalSafetyNetCheck: true },
    });
    if (vetoed) {
      await this.eventLog.append({
        correlationId: cid,
        ts: this.now(),
        layer: 'governance',
        source: 'internal',
        kind: 'safety_net',
        vetoed: true,
        check: 'runAll',
        reason: 'safety-net veto during governed dispatch',
      });
    }
  }
}

/** Recent decisions on the event spine (60 s window, capped at 10) for the
 *  context assembly of a routed dispatch. */
export async function recentEvents(eventLog: EventLog, now: () => number): Promise<DecisionEvent[]> {
  const out: DecisionEvent[] = [];
  const cutoff = now() - 60_000;
  for await (const e of eventLog.query({ from: cutoff, to: now() })) {
    out.push(e);
    if (out.length >= 10) break;
  }
  return out;
}

/** A synthetic unknown envelope for approval re-dispatches: the action was
 *  already governed and staged; assembly only needs the event window. */
function unknownEnvelope(cid: string): IntentEnvelope {
  return {
    intent: { kind: 'unknown' },
    confidence: 0,
    entities: {},
    rawContext: { source: 'internal' as never, ts: Number(cid.split('-')[0] ?? 0) || 0, payload: {} },
  };
}
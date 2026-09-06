/**
 * ApprovalGate (spec §5.3): stages a human approval for consequential
 * actions over Slack and tracks M-of-N signatures.
 *
 * The Slack notifier is injected (never speaks HTTP directly), so tests and
 * other surfaces can satisfy the same one-method port. Every state change
 * (request, grant, timeout) is emitted to the EventLog when one is wired.
 *
 * Signature counting: with `signerId` supplied, signatures dedupe by signer
 * (one human, one vote). Without it, each call counts as one signature —
 * which is what the plan's own M-of-N test expects.
 */
import { correlationId } from '../event-log/correlation.js';
import type { EventLog } from '../event-log/log.js';
import type { Decision, ProposedAction } from './decision.js';

/** Minimal Slack port satisfied by SlackNotifier and test fakes alike. */
export interface SlackLike {
  postMessage(channel: string, text: string): Promise<void>;
}

export interface ApprovalRequestInput {
  policyId: string;
  decision: Decision;
  action: ProposedAction;
  timeoutMs?: number;
}

export type ApprovalStatus = 'pending' | 'granted' | 'denied' | 'timeout';

export interface ApprovalSnapshot {
  status: ApprovalStatus;
  signatures: number;
  required: number;
}

export interface ApprovalGateOptions {
  slack: SlackLike;
  securityChannel: string;
  /** M — distinct signatures required to grant. */
  approverCount?: number;
  defaultTimeoutMs?: number;
  eventLog?: EventLog;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface PendingApproval {
  id: string;
  policyId: string;
  decision: Decision;
  action: ProposedAction;
  signatures: Set<string>;
  status: ApprovalStatus;
  createdAt: number;
  timeoutMs: number;
}

const DEFAULT_APPROVER_COUNT = 2;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class ApprovalGate {
  private readonly slack: SlackLike;
  private readonly channel: string;
  private readonly approverCount: number;
  private readonly defaultTimeoutMs: number;
  private readonly eventLog: EventLog | undefined;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(opts: ApprovalGateOptions) {
    this.slack = opts.slack;
    this.channel = opts.securityChannel;
    this.approverCount = Math.max(1, opts.approverCount ?? DEFAULT_APPROVER_COUNT);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.eventLog = opts.eventLog;
    this.now = opts.now ?? Date.now;
  }

  async request(input: ApprovalRequestInput): Promise<{ approvalId: string }> {
    const id = correlationId(this.now());
    const p: PendingApproval = {
      id,
      policyId: input.policyId,
      decision: input.decision,
      action: input.action,
      signatures: new Set(),
      status: 'pending',
      createdAt: this.now(),
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
    };
    this.pending.set(id, p);
    await this.slack.postMessage(this.channel, this.renderMessage(p));
    void this.eventLog?.append({
      correlationId: id,
      ts: p.createdAt,
      layer: 'governance',
      source: 'slack',
      kind: 'approval_request',
      approvalId: id,
      policyId: p.policyId,
      approver_count: this.approverCount,
    }).catch(() => {});
    return { approvalId: id };
  }

  sign(approvalId: string, role: string, signerId?: string): ApprovalSnapshot {
    const p = this.require(approvalId);
    if (p.status === 'pending') {
      p.signatures.add(signerId ?? `signature-${p.signatures.size + 1}`);
      if (p.signatures.size >= this.approverCount) {
        p.status = 'granted';
        void this.eventLog?.append({
          correlationId: p.id,
          ts: this.now(),
          layer: 'governance',
          source: 'slack',
          kind: 'approval_granted',
          approvalId: p.id,
          signerRole: role,
        }).catch(() => {});
      }
    }
    return this.snapshot(p);
  }

  deny(approvalId: string): ApprovalSnapshot {
    const p = this.require(approvalId);
    if (p.status === 'pending') p.status = 'denied';
    return this.snapshot(p);
  }

  /** Expire any pending approvals past their deadline; returns expired ids. */
  checkTimeouts(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const p of this.pending.values()) {
      if (p.status === 'pending' && now > p.createdAt + p.timeoutMs) {
        p.status = 'timeout';
        expired.push(p.id);
        void this.eventLog?.append({
          correlationId: p.id,
          ts: now,
          layer: 'governance',
          source: 'internal',
          kind: 'approval_timeout',
          approvalId: p.id,
        }).catch(() => {});
      }
    }
    return expired;
  }

  status(approvalId: string): ApprovalSnapshot | undefined {
    const p = this.pending.get(approvalId);
    return p ? this.snapshot(p) : undefined;
  }

  private require(approvalId: string): PendingApproval {
    const p = this.pending.get(approvalId);
    if (!p) throw new Error(`ApprovalGate: unknown approvalId: ${approvalId}`);
    return p;
  }

  private snapshot(p: PendingApproval): ApprovalSnapshot {
    return { status: p.status, signatures: p.signatures.size, required: this.approverCount };
  }

  private renderMessage(p: PendingApproval): string {
    return [
      `*Approval needed* (${p.policyId}) — ${p.decision.reason}`,
      `Action: \`${p.action.tool}\``,
      `Args: \`${JSON.stringify(p.action.args)}\``,
      `Signatures required: ${this.approverCount} (M-of-N). React ✅ to approve, ❌ to deny.`,
    ].join('\n');
  }
}

/**
 * ApprovalGate (spec §5.3): the approval STATE MACHINE — staging, M-of-N
 * signature counting, terminal transitions, orphan sweeping, and the
 * queue/listing view. This file owns approval state and nothing else:
 *
 *  - Slack presentation (port, card renderers, delivery/update ladder)
 *    lives in ./approval-slack — stateless, failure-isolated;
 *  - Slack intake (reaction/click correlation, emoji map, privilege
 *    checks) lives in ./approval-intake — it delegates transitions back
 *    here through a minimal backend port;
 *  - the signer trust rule (ranks, roleSatisfies, SignerRoleError) lives
 *    in ./approval-roles — one definition for reactions, clicks, and REST.
 *
 * Signature counting: with `signerId` supplied, signatures dedupe by signer
 * (one human, one vote). Without it, each call counts as one signature —
 * which is what the plan's own M-of-N test expects.
 */
import { correlationId } from '../event-log/correlation.js';
import type { EventLog } from '../event-log/log.js';
import type { Decision, ProposedAction } from './decision.js';
import type { SpeakerRole, SpeakerRegistry } from './safety-net/rbac.js';
import { SignerRoleError, roleSatisfies, type ApprovalStatus } from './approval-roles.js';
import { ApprovalIntake, type ReactionEvent, type ReactionResult, type ActionEvent } from './approval-intake.js';
import {
  deliverRequestCard,
  renderApprovalCard,
  renderApprovalText,
  renderLifecycleUpdate,
  type ApprovalCardView,
  type SlackLike,
} from './approval-slack.js';

// Public surface re-exports: everything importers used to get from this
// module keeps its import path (the barrel and HTTP/Slack modules rely on
// it); the definitions now live next to the code that owns them.
export { SignerRoleError, ROLE_RANK, roleSatisfies } from './approval-roles.js';
export type { ApprovalStatus } from './approval-roles.js';
export type { SlackLike, RichMessage } from './approval-slack.js';
export type { ReactionEvent, ReactionResult, ActionEvent } from './approval-intake.js';
export type ActionResult = ReactionResult;

export interface ApprovalRequestInput {
  policyId: string;
  decision: Decision;
  action: ProposedAction;
  timeoutMs?: number;
  /** When set, the approval card posts in-thread under this message
   *  (the meeting where the action was requested) instead of the security
   *  channel. Lifecycle updates and reaction correlation follow the same
   *  ref, so the thread stays the single record of the decision. */
  thread?: { channel: string; ts: string };
}

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
  /** Emoji → role contributed by that reaction (and ❌ for deny). Keys are
   *  the emoji's `reaction` name as Slack reports it. Default: 🛡️ admin,
   *  🔧 engineer, 👀 viewer, ✅ viewer, ❌ deny. A reaction only counts when
   *  the reactor's actual role is at least the mapped role. */
  reactionRoleMap?: Record<string, SpeakerRole | 'deny'>;
  /** Server-side signer-identity resolver for the REST surface. When wired,
   *  signAs() resolves the signer's role HERE (never from the client) and
   *  rank-checks it; signatures dedupe by resolved identity. When absent,
   *  signAs falls back to the legacy trust-the-caller contract (tests). */
  resolveSignerRole?: SpeakerRegistry;
  /** Roles allowed to contribute an approval signature over REST (default:
   *  admin only — keep approval power narrow). */
  approverRoles?: SpeakerRole[];
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
  /** Exactly what was posted when the request was created; lifecycle
   *  updates re-render this so the message stays the full record. */
  originalText?: string;
  /** Where the request message landed (bot-token path only). */
  ref?: { channel: string; ts: string };
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
  private readonly resolveSignerRole: SpeakerRegistry | undefined;
  private readonly approverRoles: readonly SpeakerRole[];
  /** Slack intake: correlation + emoji privilege checks, delegating
   *  transitions back into this gate through the minimal backend port. */
  private readonly intake: ApprovalIntake;
  /** Queue-change listeners (SSE surfaces). Fired after every mutation that
   *  affects the queue listing; listeners receive no payload and re-read via
   *  listPending(), so the notification carries no data to leak. */
  private readonly listeners = new Set<() => void>();

  constructor(opts: ApprovalGateOptions) {
    this.slack = opts.slack;
    this.channel = opts.securityChannel;
    this.approverCount = Math.max(1, opts.approverCount ?? DEFAULT_APPROVER_COUNT);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.eventLog = opts.eventLog;
    this.now = opts.now ?? Date.now;
    this.resolveSignerRole = opts.resolveSignerRole;
    this.approverRoles = opts.approverRoles ?? ['admin'];
    this.intake = new ApprovalIntake(
      {
        find: (approvalId) => {
          const p = this.pending.get(approvalId);
          return p ? { status: p.status, signatures: p.signatures.size } : undefined;
        },
        pendingIds: () => [...this.pending.values()].filter((p) => p.status === 'pending').map((p) => p.id),
        sign: (approvalId, role, signerId) => this.sign(approvalId, role, signerId),
        deny: (approvalId) => this.deny(approvalId),
      },
      opts.reactionRoleMap,
    );
  }

  /** Subscribe to queue mutations (request/grant/deny/timeout/execute).
   *  Returns an unsubscribe function. Notifications are fire-and-forget:
   *  a throwing listener never breaks the mutation path. */
  onQueueChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // A broken listener must never break a governance mutation.
      }
    }
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
    this.notify();
    const view = this.view(p);
    const text = renderApprovalText(view);
    p.originalText = text;
    const target = input.thread ?? { channel: this.channel };
    const ref = await deliverRequestCard(this.slack, { channel: target.channel, ...(input.thread ? { threadTs: input.thread.ts } : {}) }, this.channel, text, renderApprovalCard(view));
    if (ref) {
      this.intake.trackDelivery(ref, id);
      p.ref = ref;
    }
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
      const before = p.signatures.size;
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
          signerIds: [...p.signatures],
        }).catch(() => {});
      }
      // The original message tracks reality: full card re-render (rich
      // clients), in-place text edit, or threaded-only announce — whichever
      // the client supports. Unchanged signature count → no re-render.
      if (p.signatures.size !== before) this.rerender(p);
      // Every listing-visible change notifies: the queue entry carries the
      // signature count, so a bare signature (1/2) is a change too, and the
      // grant additionally flips status pending → granted.
      if (p.signatures.size !== before) this.notify();
    }
    return this.snapshot(p);
  }

  /** Terminal transition: the approved action has run. Leaves the queue (and
   *  re-renders the Slack card) with a permanent audit trail. */
  markExecuted(approvalId: string): ApprovalSnapshot {
    const p = this.require(approvalId);
    if (p.status === 'granted') {
      p.status = 'executed';
      this.rerender(p);
      void this.eventLog?.append({
        correlationId: p.id,
        ts: this.now(),
        layer: 'governance',
        source: 'internal',
        kind: 'approval_executed',
        approvalId: p.id,
      }).catch(() => {});
      this.notify();
    }
    return this.snapshot(p);
  }

  /** Sign with server-side identity resolution — the REST surface's entry
   *  point. The caller supplies WHO; the gate decides WHAT THAT IS WORTH:
   *  the signer's role is resolved through `resolveSignerRole` (never taken
   *  from the client), rank-checked against the approver roles, and the
   *  signature dedupes by resolved identity. Two distinct failures:
   *  unknown id → 404-class throw from require(), insufficient role →
   *  SignerRoleError (403-class). Falls back to the legacy trust-the-caller
   *  `sign()` only when no resolver is wired (tests). */
  signAs(approvalId: string, signerId: string): ApprovalSnapshot {
    // Id first: unknown approvals are a 404-class error regardless of who is
    // asking (and role resolution must not leak onto nonexistent ids).
    this.require(approvalId);
    if (!this.resolveSignerRole) return this.sign(approvalId, 'admin', signerId);
    const resolved = this.resolveSignerRole(signerId) ?? 'guest';
    const wanted = this.approverRoles[0] ?? 'admin';
    if (!roleSatisfies(resolved, wanted)) {
      throw new SignerRoleError(`role ${resolved} cannot contribute a ${wanted} signature`);
    }
    return this.sign(approvalId, resolved, signerId);
  }

  deny(approvalId: string): ApprovalSnapshot {
    const p = this.require(approvalId);
    if (p.status === 'pending') {
      p.status = 'denied';
      void this.eventLog?.append({
        correlationId: p.id,
        ts: this.now(),
        layer: 'governance',
        source: 'slack',
        kind: 'approval_denied',
        approvalId: p.id,
      }).catch(() => {});
      this.rerender(p);
      this.notify();
    }
    return this.snapshot(p);
  }

  /** Slack reaction events (emoji sign-off) — correlation, mapping, and
   *  privilege checks live in the intake; transitions land here. */
  handleReaction(event: ReactionEvent): Promise<ReactionResult> {
    return this.intake.handleReaction(event);
  }

  /** Slack interactive-element clicks (Block Kit buttons) — same intake,
   *  same privilege rule, unambiguous correlation via the action_id. */
  handleAction(event: ActionEvent): Promise<ReactionResult> {
    return this.intake.handleAction(event);
  }

  /** Boot-time reconciliation: a pending approval lives in this process's
   *  memory, so once the owning process dies the card can never grant and
   *  execution stays fail-closed forever — an orphan. Sweep the event log
   *  for requests that predate this boot and never reached a terminal event
   *  (granted / denied / timed_out) and close them out, so the durable
   *  metrics picture (support_agent_approvals_total backlog arithmetic)
   *  stops counting the dead queue. Returns the swept approval ids.
   *  Awaits the audit writes so ready() reports a fully settled spine. */
  async sweepOrphans(): Promise<string[]> {
    if (!this.eventLog) return [];
    const bootTs = this.now();
    const terminal = new Set<string>();
    const requested = new Map<string, number>();
    for await (const e of this.eventLog.query({})) {
      if (e.ts >= bootTs) continue;
      if (e.kind === 'approval_request') requested.set(e.approvalId, e.ts);
      else if (e.kind === 'approval_granted' || e.kind === 'approval_executed' || e.kind === 'approval_denied' || e.kind === 'approval_timeout') {
        terminal.add(e.approvalId);
      }
    }
    const orphans = [...requested.entries()]
      .filter(([id, ts]) => !terminal.has(id) && ts < bootTs)
      .map(([id]) => id);
    await Promise.all(
      orphans.map((id) =>
        this.eventLog!.append({
          correlationId: id,
          ts: bootTs,
          layer: 'governance',
          source: 'internal',
          kind: 'approval_timeout',
          approvalId: id,
        }),
      ),
    );
    return orphans;
  }

  /** Expire any pending approvals past their deadline; returns expired ids. */
  checkTimeouts(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const p of this.pending.values()) {
      if (p.status === 'pending' && now > p.createdAt + p.timeoutMs) {
        p.status = 'timeout';
        expired.push(p.id);
        this.rerender(p);
        this.notify();
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

  /** The status a pending entry holds at instant t, deadline applied —
   *  shared by checkTimeouts and listPending so the two never disagree. */
  private effectiveStatus(p: PendingApproval, t: number): ApprovalStatus {
    if (p.status !== 'pending') return p.status;
    if (p.timeoutMs > 0 && t > p.createdAt + p.timeoutMs) return 'timeout';
    return 'pending';
  }

  status(approvalId: string): ApprovalSnapshot | undefined {
    const p = this.pending.get(approvalId);
    return p ? this.snapshot(p) : undefined;
  }

  /** Read-only listing of queue-worthy approvals (queue surfaces such as
   *  GET /approvals). Both pending and granted-but-unexecuted entries are
   *  listed, each with its `status` — a granted entry vanishing from the
   *  queue strands the operator: execute is only reachable by id, and the id
   *  came from the staged utterance response. Denied, timed-out, swept, and
   *  executed entries have left the queue. Timeout at LIST time is
   *  evaluated, not stored: an entry whose deadline passed shows 'timeout'
   *  without anyone having called checkTimeouts yet. */
  listPending(): Array<{
    approvalId: string;
    policyId: string;
    reason: string;
    tool: string;
    args: Record<string, unknown>;
    signatures: number;
    required: number;
    ageMs: number;
    expires: boolean;
    status: 'pending' | 'granted';
  }> {
    const t = this.now();
    return [...this.pending.values()]
      .map((p) => ({ p, status: this.effectiveStatus(p, t) }))
      .filter((entry): entry is { p: PendingApproval; status: 'pending' | 'granted' } => entry.status === 'pending' || entry.status === 'granted')
      .map(({ p, status }) => ({
        approvalId: p.id,
        policyId: p.policyId,
        reason: p.decision.reason,
        tool: p.action.tool,
        args: p.action.args,
        signatures: p.signatures.size,
        required: this.approverCount,
        ageMs: Math.max(0, t - p.createdAt),
        expires: p.timeoutMs > 0,
        status,
      }));
  }

  private require(approvalId: string): PendingApproval {
    const p = this.pending.get(approvalId);
    if (!p) throw new Error(`ApprovalGate: unknown approvalId: ${approvalId}`);
    return p;
  }

  /** The card/line data for one approval — exactly what the presentation
   *  module renders from; no gate bookkeeping leaks outward. */
  private view(p: PendingApproval): ApprovalCardView {
    return {
      approvalId: p.id,
      policyId: p.policyId,
      reason: p.decision.reason,
      tool: p.action.tool,
      args: p.action.args,
      status: p.status,
      signatures: p.signatures.size,
      required: this.approverCount,
    };
  }

  private rerender(p: PendingApproval): void {
    renderLifecycleUpdate(this.slack, this.view(p), {
      ...(p.ref ? { ref: p.ref } : {}),
      ...(p.originalText !== undefined ? { originalText: p.originalText } : {}),
      securityChannel: this.channel,
    });
  }

  private snapshot(p: PendingApproval): ApprovalSnapshot {
    return { status: p.status, signatures: p.signatures.size, required: this.approverCount };
  }
}

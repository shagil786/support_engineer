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
import type { SpeakerRole } from './safety-net/rbac.js';

/** Minimal Slack port satisfied by SlackNotifier and test fakes alike.
 *  Everything past `postMessage` is OPTIONAL — capability probing, never
 *  requirement: `postMessageWithRef` (bot tokens) enables reaction
 *  correlation, `postRichMessage`/`updateRichMessage` enable Block Kit
 *  cards, `updateMessage`/`postReply` enable in-place lifecycle edits. */
export interface SlackLike {
  postMessage(channel: string, text: string): Promise<void>;
  postMessageWithRef?(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  /** Edit the original message in place (chat.update). Present on bot-token
   *  clients; preferred for grant/deny/timeout so the message is the record. */
  updateMessage?(channel: string, ts: string, text: string): Promise<void>;
  /** Reply in-thread under the original message (chat.postMessage with
   *  thread_ts). Middle rung of the lifecycle-update ladder. */
  postReply?(channel: string, ts: string, text: string): Promise<void>;
  /** Post a rich Block Kit message (cards). Returns the ref so interactive
   *  elements can be updated in place later. */
  postRichMessage?(channel: string, message: RichMessage): Promise<{ channel: string; ts: string }>;
  /** Re-render a posted rich message (chat.update with blocks/attachments). */
  updateRichMessage?(channel: string, ts: string, message: RichMessage): Promise<void>;
}

/** Slack message with optional Block Kit payload. `text` is the fallback
 *  (notifications, plain clients); `attachments`/`blocks` are Slack's JSON
 *  shapes, left structural so this port stays dependency-free. */
export interface RichMessage {
  text: string;
  attachments?: unknown[];
  blocks?: unknown[];
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
  /** Emoji → role contributed by that reaction (and ❌ for deny). Keys are
   *  the emoji's `reaction` name as Slack reports it. Default: 🛡️ admin,
   *  🔧 engineer, 👀 viewer, ✅ viewer, ❌ deny. A reaction only counts when
   *  the reactor's actual role is at least the mapped role. */
  reactionRoleMap?: Record<string, SpeakerRole | 'deny'>;
}

export interface ReactionEvent {
  type: 'reaction_added' | 'reaction_removed';
  /** Slack reaction name, e.g. 'raised_hands' or the emoji itself. */
  reaction: string;
  userId: string;
  /** Resolved server-side (NEVER client-asserted as privilege — see below). */
  userRole?: SpeakerRole;
  channel?: string;
  ts?: string;
}

export interface ReactionResult {
  matched: boolean;
  accepted?: boolean;
  approvalId?: string;
  status?: ApprovalStatus;
  signatures?: number;
  reason?: string;
}

/** A Slack interactive-element click (block_actions). The approval id rides
 *  INSIDE the action_id (`approval:approve:<id>`), so correlation never
 *  depends on which message the button lived on. */
export interface ActionEvent {
  actionId: string;
  userId: string;
  /** Resolved server-side by the host — a click proves identity, not role. */
  userRole?: SpeakerRole;
}

export type ActionResult = ReactionResult;

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
/** Emoji → contribution. A reaction is a claim: it only counts when the
 *  reactor's resolved role is at least the mapped role. ❌ always denies.
 *  Keys cover both the emoji itself and Slack's reaction *name* for it
 *  (the Events API reports 'white_check_mark', not '✅'). */
const DEFAULT_REACTION_ROLES: Record<string, SpeakerRole | 'deny'> = {
  '🛡️': 'admin',
  'shield': 'admin',
  '🔧': 'engineer',
  'wrench': 'engineer',
  '👀': 'viewer',
  'eyes': 'viewer',
  '✅': 'viewer',
  'white_check_mark': 'viewer',
  '❌': 'deny',
  'x': 'deny',
};
const ROLE_RANK: Record<SpeakerRole, number> = { admin: 0, engineer: 1, viewer: 2, guest: 3 };

export class ApprovalGate {
  private readonly slack: SlackLike;
  private readonly channel: string;
  private readonly approverCount: number;
  private readonly defaultTimeoutMs: number;
  private readonly eventLog: EventLog | undefined;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly reactionRoles: Record<string, SpeakerRole | 'deny'>;
  /** 'channel:ts' of posted approval messages → approvalId (bot-token only;
   *  webhook posters have no ref and rely on the single-pending fallback). */
  private readonly deliveries = new Map<string, string>();

  constructor(opts: ApprovalGateOptions) {
    this.slack = opts.slack;
    this.channel = opts.securityChannel;
    this.approverCount = Math.max(1, opts.approverCount ?? DEFAULT_APPROVER_COUNT);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.eventLog = opts.eventLog;
    this.now = opts.now ?? Date.now;
    this.reactionRoles = opts.reactionRoleMap ?? DEFAULT_REACTION_ROLES;
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
    const text = this.renderMessage(p);
    p.originalText = text;
    let delivered = false;
    if (this.slack.postRichMessage) {
      // Richest path: Block Kit card with state color + buttons.
      try {
        const ref = await this.slack.postRichMessage(this.channel, this.renderRich(p));
        this.deliveries.set(`${ref.channel}:${ref.ts}`, id);
        p.ref = { channel: ref.channel, ts: ref.ts };
        delivered = true;
      } catch {
        /* fall through to the text ladder */
      }
    }
    if (!delivered && this.slack.postMessageWithRef) {
      // Bot-token path: record the message ref so reactions correlate to
      // THIS approval even with several pending at once.
      try {
        const ref = await this.slack.postMessageWithRef(this.channel, text);
        this.deliveries.set(`${ref.channel}:${ref.ts}`, id);
        p.ref = { channel: ref.channel, ts: ref.ts };
        delivered = true;
      } catch {
        await this.slack.postMessage(this.channel, text);
      }
    }
    if (!delivered) {
      await this.slack.postMessage(this.channel, text);
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
        }).catch(() => {});
      }
      // The original message tracks reality: full card re-render (rich
      // clients), in-place text edit, or threaded-only announce — whichever
      // the client supports. Unchanged signature count → no re-render.
      if (p.signatures.size !== before) this.rerender(p);
    }
    return this.snapshot(p);
  }

  deny(approvalId: string): ApprovalSnapshot {
    const p = this.require(approvalId);
    if (p.status === 'pending') {
      p.status = 'denied';
      this.rerender(p);
    }
    return this.snapshot(p);
  }

  /** Handle a Slack reaction event against the approval messages this gate
   *  posted. Correlation: exact message ref first, then the single pending
   *  approval (ambiguous with several pending → not matched, fail safe). */
  async handleReaction(event: ReactionEvent): Promise<ReactionResult> {
    if (event.type === 'reaction_removed') {
      return { matched: false, reason: 'reaction removals never change approval state' };
    }
    let approvalId: string | undefined = event.channel && event.ts ? this.deliveries.get(`${event.channel}:${event.ts}`) : undefined;
    if (!approvalId) {
      const pendings = [...this.pending.values()].filter((p) => p.status === 'pending');
      const only = pendings.length === 1 ? pendings[0] : undefined;
      if (pendings.length > 1) {
        return { matched: false, reason: `ambiguous: ${pendings.length} pending approvals and the message ref is unknown` };
      }
      if (!only) return { matched: false, reason: 'no pending approval' };
      approvalId = only.id;
    }
    const p = this.require(approvalId);
    const matched: ReactionResult = { matched: true, approvalId };
    if (p.status !== 'pending') {
      return { ...matched, accepted: false, status: p.status, signatures: p.signatures.size, reason: `approval already ${p.status}` };
    }
    const mapped = this.reactionRoles[event.reaction];
    if (!mapped) {
      return { ...matched, accepted: false, reason: `reaction ${event.reaction} is not an approval signal` };
    }
    if (mapped === 'deny') {
      this.deny(approvalId);
      return { ...matched, accepted: true, status: 'denied', signatures: p.signatures.size };
    }
    // Privilege gate: the reaction claims `mapped`; the reactor must hold it.
    // userRole comes from the host's server-side resolver, never the client.
    if (!event.userRole || ROLE_RANK[event.userRole] > ROLE_RANK[mapped]) {
      return { ...matched, accepted: false, reason: `role ${event.userRole ?? 'unknown'} cannot contribute a ${mapped} signature` };
    }
    const snap = this.sign(approvalId, mapped, event.userId);
    return { ...matched, accepted: true, status: snap.status, signatures: snap.signatures };
  }

  /** Handle a Slack interactive-element click (block_actions). The approval
   *  id is embedded in the action_id, so clicks correlate unambiguously even
   *  with several pending approvals. Shares the role gate and dedupe with
   *  reactions. */
  async handleAction(event: ActionEvent): Promise<ActionResult> {
    const m = /^approval:(approve|deny):(.+)$/.exec(event.actionId);
    const verb = m?.[1];
    const approvalId = m?.[2];
    if (!verb || !approvalId) return { matched: false, reason: 'not an approval action' };
    const p = this.tryGet(approvalId);
    if (!p) return { matched: false, reason: `unknown approvalId: ${approvalId}` };
    const base: ActionResult = { matched: true, approvalId };
    if (p.status !== 'pending') {
      return { ...base, accepted: false, status: p.status, signatures: p.signatures.size, reason: `approval already ${p.status}` };
    }
    if (verb === 'deny') {
      this.deny(approvalId);
      return { ...base, accepted: true, status: 'denied', signatures: p.signatures.size };
    }
    // Approve: same privilege rule as reactions — a click proves identity,
    // the server-resolved role decides what it is worth.
    const mapped = 'admin' as SpeakerRole;
    if (!event.userRole || ROLE_RANK[event.userRole] > ROLE_RANK[mapped]) {
      return { ...base, accepted: false, reason: `role ${event.userRole ?? 'unknown'} cannot contribute a ${mapped} signature` };
    }
    const snap = this.sign(approvalId, mapped, event.userId);
    return { ...base, accepted: true, status: snap.status, signatures: snap.signatures };
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

  private tryGet(approvalId: string): PendingApproval | undefined {
    return this.pending.get(approvalId);
  }

  /** The Block Kit card. Color encodes state: ⚠️ warning pending, 🟢 good
   *  granted, 🔴 danger denied, 🟠 warning timeout; buttons vanish once the
   *  approval resolves. `text` mirrors the state for notifications and
   *  plain-text fallback. */
  private renderRich(p: PendingApproval): RichMessage {
    const state =
      p.status === 'granted'
        ? { color: 'good', head: '*Approval GRANTED*', sub: `Signatures: ${p.signatures.size}/${this.approverCount}. Executing.` }
        : p.status === 'denied'
          ? { color: 'danger', head: '*Approval DENIED*', sub: `Action \`${p.action.tool}\` will not execute.` }
          : p.status === 'timeout'
            ? { color: 'warning', head: '*Approval TIMED OUT*', sub: `Action \`${p.action.tool}\` was not approved in time.` }
            : { color: 'warning', head: '*Approval needed*', sub: `Signatures: ${p.signatures.size}/${this.approverCount}.` };
    const detail = [
      `*${state.head}* (${p.policyId}) — ${p.decision.reason}`,
      `Action: \`${p.action.tool}\`  ·  Args: \`${JSON.stringify(p.action.args)}\`  ·  ${state.sub}`,
    ].join('\n');
    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text: detail } },
    ];
    if (p.status === 'pending') {
      blocks.push({
        type: 'actions',
        elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve', emoji: true }, action_id: `approval:approve:${p.id}` },
          { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny', emoji: true }, action_id: `approval:deny:${p.id}` },
        ],
      });
    }
    const messageText = `${state.head} (${p.policyId}) — ${p.action.tool} — ${state.sub}`;
    return {
      text: messageText,
      attachments: [{ color: state.color, blocks }],
    };
  }

  /** Lifecycle re-render on the rich ladder: full card update in place when
   *  the client can, else the text ladder (announce), else standalone. */
  private rerender(p: PendingApproval): void {
    const ref = p.ref;
    const textLine =
      p.status === 'granted'
        ? `*Approval GRANTED* (${p.policyId}) — ${p.signatures.size}/${this.approverCount} signatures. Executing.`
        : p.status === 'denied'
          ? `*Approval DENIED* (${p.policyId}) — action \`${p.action.tool}\` will not execute.`
          : p.status === 'timeout'
            ? `*Approval TIMED OUT* (${p.policyId}) — action \`${p.action.tool}\` will not execute. Re-request if still needed.`
            : `Signatures: ${p.signatures.size}/${this.approverCount} — pending.`;
    if (ref && this.slack.updateRichMessage) {
      void this.slack.updateRichMessage(ref.channel, ref.ts, this.renderRich(p)).catch(() => this.announce(p, textLine));
      return;
    }
    this.announce(p, textLine, p.status === 'granted' || p.status === 'pending' ? 'threaded' : 'ladder');
  }

  /** Fire-and-forget follow-up (deny/timeout): sync callers must never block
   *  on Slack, and a delivery failure must never break the governance path. */
  private postFollowUp(p: PendingApproval, text: string): void {
    void this.slack.postMessage(this.channel, text).catch(() => {});
  }

  /** Announce a lifecycle change on the ORIGINAL message: update in place
   *  when the client can, reply in-thread otherwise. 'ladder' mode (deny/
   *  timeout) falls back to a standalone channel post; 'threaded' mode
   *  (grant/progress) stays silent without a thread — never spams the
   *  channel. Always fire-and-forget (see postFollowUp). */
  private announce(p: PendingApproval, line: string, mode: 'ladder' | 'threaded' = 'ladder'): void {
    const ref = p.ref;
    const fallback = mode === 'ladder' ? () => this.postFollowUp(p, line) : undefined;
    if (ref && this.slack.updateMessage) {
      void this.slack
        .updateMessage(ref.channel, ref.ts, `${p.originalText ?? ''}\n\n${line}`)
        .catch(() => fallback?.());
      return;
    }
    if (ref && this.slack.postReply) {
      void this.slack.postReply(ref.channel, ref.ts, line).catch(() => fallback?.());
      return;
    }
    fallback?.();
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

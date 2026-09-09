/**
 * Slack intake for the approval gate — reactions and Block Kit clicks.
 *
 * Owns the two things the SLACK SURFACE uniquely knows:
 *  - correlation: which approval a reaction/click refers to (exact message
 *    ref first, single-pending fallback with a fail-safe ambiguity rule),
 *  - the emoji → contribution map, a claim that only counts when the
 *    reactor's SERVER-RESOLVED role is at least the mapped role.
 *
 * A click proves identity, never privilege: the role comes from the host's
 * registry and the same rank rule as the REST surface decides what it is
 * worth. State transitions are delegated to the gate (sign/deny).
 */
import type { SpeakerRole } from './safety-net/rbac.js';
import { ROLE_RANK } from './approval-roles.js';
import type { ApprovalStatus } from './approval-roles.js';

/** Emoji → contribution. A reaction is a claim: it only counts when the
 *  reactor's resolved role is at least the mapped role. ❌ always denies.
 *  Keys cover both the emoji itself and Slack's reaction *name* for it
 *  (the Events API reports 'white_check_mark', not '✅'). */
export const DEFAULT_REACTION_ROLES: Record<string, SpeakerRole | 'deny'> = {
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

export interface ReactionEvent {
  type: 'reaction_added' | 'reaction_removed';
  /** Slack reaction name, e.g. 'raised_hands' or the emoji itself. */
  reaction: string;
  userId: string;
  /** Resolved server-side (NEVER client-asserted as privilege). */
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

/** What the intake needs from the gate: minimal read/write access to the
 *  approval state, nothing about Slack. Implemented by ApprovalGate. */
export interface IntakeBackend {
  /** Resolve a live approval id; undefined when unknown/expired. */
  find(approvalId: string): { status: ApprovalStatus; signatures: number } | undefined;
  /** Every pending entry's id (correlation fallback). */
  pendingIds(): string[];
  /** Contribute one signature (dedupe by signer inside). */
  sign(approvalId: string, role: SpeakerRole, signerId: string): { status: ApprovalStatus; signatures: number };
  /** Terminal deny. */
  deny(approvalId: string): void;
}

/** Shared intake helper: the privilege rule — contribute `mapped` only when
 *  the resolved role holds it. Callers own the status guard. */
function contribute(
  backend: IntakeBackend,
  approvalId: string,
  mapped: SpeakerRole,
  userId: string,
  userRole: SpeakerRole | undefined,
  base: ReactionResult,
): ReactionResult {
  if (!userRole || ROLE_RANK[userRole] > ROLE_RANK[mapped]) {
    return { ...base, accepted: false, reason: `role ${userRole ?? 'unknown'} cannot contribute a ${mapped} signature` };
  }
  const snap = backend.sign(approvalId, mapped, userId);
  return { ...base, accepted: true, status: snap.status, signatures: snap.signatures };
}

export class ApprovalIntake {
  private readonly backend: IntakeBackend;
  private readonly reactionRoles: Record<string, SpeakerRole | 'deny'>;
  /** 'channel:ts' of posted approval messages → approvalId (bot-token only;
   *  webhook posters have no ref and rely on the single-pending fallback). */
  private readonly deliveries = new Map<string, string>();

  constructor(backend: IntakeBackend, reactionRoles?: Record<string, SpeakerRole | 'deny'>) {
    this.backend = backend;
    this.reactionRoles = reactionRoles ?? DEFAULT_REACTION_ROLES;
  }

  /** Record where a request card landed so reactions correlate exactly. */
  trackDelivery(ref: { channel: string; ts: string }, approvalId: string): void {
    this.deliveries.set(`${ref.channel}:${ref.ts}`, approvalId);
  }

  /** Handle a Slack reaction event against the approval messages this gate
   *  posted. Correlation: exact message ref first, then the single pending
   *  approval (ambiguous with several pending → not matched, fail safe). */
  handleReaction(event: ReactionEvent): Promise<ReactionResult> {
    if (event.type === 'reaction_removed') {
      return Promise.resolve({ matched: false, reason: 'reaction removals never change approval state' });
    }
    let approvalId: string | undefined = event.channel && event.ts ? this.deliveries.get(`${event.channel}:${event.ts}`) : undefined;
    if (!approvalId) {
      const pendings = this.backend.pendingIds();
      const only = pendings.length === 1 ? pendings[0] : undefined;
      if (pendings.length > 1) {
        return Promise.resolve({ matched: false, reason: `ambiguous: ${pendings.length} pending approvals and the message ref is unknown` });
      }
      if (!only) return Promise.resolve({ matched: false, reason: 'no pending approval' });
      approvalId = only;
    }
    const matched: ReactionResult = { matched: true, approvalId };
    // Status guard BEFORE interpreting the emoji: a resolved approval stays
    // resolved no matter what arrives next.
    const p = this.backend.find(approvalId);
    if (!p) throw new Error(`ApprovalGate: unknown approvalId: ${approvalId}`);
    if (p.status !== 'pending') {
      return Promise.resolve({ ...matched, accepted: false, status: p.status, signatures: p.signatures, reason: `approval already ${p.status}` });
    }
    const mapped = this.reactionRoles[event.reaction];
    if (!mapped) {
      return Promise.resolve({ ...matched, accepted: false, reason: `reaction ${event.reaction} is not an approval signal` });
    }
    if (mapped === 'deny') {
      this.backend.deny(approvalId);
      return Promise.resolve({ ...matched, accepted: true, status: 'denied', signatures: p.signatures });
    }
    return Promise.resolve(contribute(this.backend, approvalId, mapped, event.userId, event.userRole, matched));
  }

  /** Handle a Slack interactive-element click (block_actions). The approval
   *  id is embedded in the action_id, so clicks correlate unambiguously even
   *  with several pending approvals. Shares the role gate and dedupe with
   *  reactions. */
  handleAction(event: ActionEvent): Promise<ReactionResult> {
    const m = /^approval:(approve|deny):(.+)$/.exec(event.actionId);
    const verb = m?.[1];
    const approvalId = m?.[2];
    if (!verb || !approvalId) return Promise.resolve({ matched: false, reason: 'not an approval action' });
    const p = this.backend.find(approvalId);
    if (!p) return Promise.resolve({ matched: false, reason: `unknown approvalId: ${approvalId}` });
    const base: ReactionResult = { matched: true, approvalId };
    // Status guard before the verb: a deny click on a granted approval is
    // 'already granted', never a fresh denial.
    if (p.status !== 'pending') {
      return Promise.resolve({ ...base, accepted: false, status: p.status, signatures: p.signatures, reason: `approval already ${p.status}` });
    }
    if (verb === 'deny') {
      this.backend.deny(approvalId);
      return Promise.resolve({ ...base, accepted: true, status: 'denied', signatures: p.signatures });
    }
    // Approve: same privilege rule as reactions — a click proves identity,
    // the server-resolved role decides what it is worth.
    return Promise.resolve(contribute(this.backend, approvalId, 'admin', event.userId, event.userRole, base));
  }
}

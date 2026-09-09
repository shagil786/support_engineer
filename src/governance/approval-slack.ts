/**
 * Slack presentation for the approval gate — the delivery port, the two
 * message renderers, and the delivery/update ladder.
 *
 * Everything here is STATELESS presentation: it renders a card from a
 * snapshot view and speaks to Slack through the injected port. It holds no
 * approval state, so a rendering or delivery failure can never corrupt the
 * gate's transitions (renderers never throw into the gate; lifecycle
 * updates are fire-and-forget).
 */
import type { ApprovalStatus } from './approval-roles.js';

/** Minimal Slack port satisfied by SlackNotifier and test fakes alike.
 *  Everything past `postMessage` is OPTIONAL — capability probing, never
 *  requirement: `postMessageWithRef` (bot tokens) enables reaction
 *  correlation, `postRichMessage`/`updateRichMessage` enable Block Kit
 *  cards, `updateMessage`/`postReply` enable in-place lifecycle edits. */
export interface SlackLike {
  postMessage(channel: string, text: string): Promise<void>;
  /** Post in-thread under an existing message (chat.postMessage with
   *  thread_ts) and resolve the reply's ref. Present on bot-token clients;
  *  enables meeting-thread approval cards. */
  postThreadMessage?(channel: string, threadTs: string, text: string): Promise<{ channel: string; ts: string }>;
  /** Rich variant of postThreadMessage (Block Kit card in-thread). */
  postRichThreadMessage?(channel: string, threadTs: string, message: RichMessage): Promise<{ channel: string; ts: string }>;
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

/** The card's data: exactly what the renderers need, none of the gate's
 *  bookkeeping (signatures sets, refs, timers stay in the gate). */
export interface ApprovalCardView {
  /** The gate's correlation id — embedded in button action_ids so clicks
   *  resolve unambiguously (approval:approve:<approvalId>). */
  approvalId: string;
  policyId: string;
  reason: string;
  tool: string;
  args: Record<string, unknown>;
  status: ApprovalStatus;
  signatures: number;
  required: number;
}

/** The Block Kit card. Color encodes state: ⚠️ warning pending, 🟢 good
 *  granted, 🔴 danger denied, 🟠 warning timeout; buttons vanish once the
 *  approval resolves. `text` mirrors the state for notifications and
 *  plain-text fallback. */
export function renderApprovalCard(view: ApprovalCardView): RichMessage {
  const state =
    view.status === 'granted'
      ? { color: 'good', head: '*Approval GRANTED*', sub: `Signatures: ${view.signatures}/${view.required}. Executing.` }
      : view.status === 'executed'
        ? { color: 'good', head: '*Approval EXECUTED*', sub: `Action \`${view.tool}\` has run under governance.` }
        : view.status === 'denied'
        ? { color: 'danger', head: '*Approval DENIED*', sub: `Action \`${view.tool}\` will not execute.` }
        : view.status === 'timeout'
          ? { color: 'warning', head: '*Approval TIMED OUT*', sub: `Action \`${view.tool}\` was not approved in time.` }
          : { color: 'warning', head: '*Approval needed*', sub: `Signatures: ${view.signatures}/${view.required}.` };
  const detail = [
    `*${state.head}* (${view.policyId}) — ${view.reason}`,
    `Action: \`${view.tool}\`  ·  Args: \`${JSON.stringify(view.args)}\`  ·  ${state.sub}`,
  ].join('\n');
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: detail } },
  ];
  if (view.status === 'pending') {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve', emoji: true }, action_id: `approval:approve:${view.approvalId}` },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny', emoji: true }, action_id: `approval:deny:${view.approvalId}` },
      ],
    });
  }
  const messageText = `${state.head} (${view.policyId}) — ${view.tool} — ${state.sub}`;
  return {
    text: messageText,
    attachments: [{ color: state.color, blocks }],
  };
}

/** The initial plain-text request message (webhook clients, fallbacks). */
export function renderApprovalText(view: ApprovalCardView): string {
  return [
    `*Approval needed* (${view.policyId}) — ${view.reason}`,
    `Action: \`${view.tool}\``,
    `Args: \`${JSON.stringify(view.args)}\``,
    `Signatures required: ${view.required} (M-of-N). React ✅ to approve, ❌ to deny.`,
  ].join('\n');
}

/** The one-line lifecycle progress note (updates on the original message). */
export function renderLifecycleLine(view: ApprovalCardView): string {
  return (
    view.status === 'granted'
      ? `*Approval GRANTED* (${view.policyId}) — ${view.signatures}/${view.required} signatures. Executing.`
      : view.status === 'executed'
        ? `*Approval EXECUTED* (${view.policyId}) — action \`${view.tool}\` has run under governance.`
        : view.status === 'denied'
        ? `*Approval DENIED* (${view.policyId}) — action \`${view.tool}\` will not execute.`
        : view.status === 'timeout'
          ? `*Approval TIMED OUT* (${view.policyId}) — action \`${view.tool}\` will not execute. Re-request if still needed.`
          : `Signatures: ${view.signatures}/${view.required} — pending.`
  );
}

/** Post a fresh request on the richest rung the client supports and return
 *  the message ref (reaction correlation), or undefined when only the plain
 *  webhook post was possible. Ladder, richest first: thread+rich card →
 *  security-channel rich card → thread+plain → security-channel with ref →
 *  plain post. */
export async function deliverRequestCard(
  slack: SlackLike,
  target: { channel: string; threadTs?: string },
  securityChannel: string,
  text: string,
  rich: RichMessage,
): Promise<{ channel: string; ts: string } | undefined> {
  if (target.threadTs !== undefined && slack.postRichThreadMessage) {
    try {
      return await slack.postRichThreadMessage(target.channel, target.threadTs, rich);
    } catch {
      /* fall through to the text ladder */
    }
  }
  if (slack.postRichMessage) {
    try {
      return await slack.postRichMessage(securityChannel, rich);
    } catch {
      /* fall through to the text ladder */
    }
  }
  if (target.threadTs !== undefined && slack.postThreadMessage) {
    try {
      return await slack.postThreadMessage(target.channel, target.threadTs, text);
    } catch {
      await slack.postMessage(securityChannel, text);
      return undefined;
    }
  }
  if (slack.postMessageWithRef) {
    try {
      return await slack.postMessageWithRef(securityChannel, text);
    } catch {
      await slack.postMessage(securityChannel, text);
      return undefined;
    }
  }
  await slack.postMessage(securityChannel, text);
  return undefined;
}

/** Fire-and-forget follow-up (deny/timeout): sync callers must never block
 *  on Slack, and a delivery failure must never break the governance path. */
function postFollowUp(slack: SlackLike, securityChannel: string, text: string): void {
  void slack.postMessage(securityChannel, text).catch(() => {});
}

/** Announce a lifecycle change on the ORIGINAL message: update in place
 *  when the client can, reply in-thread otherwise. 'ladder' mode (deny/
 *  timeout) falls back to a standalone channel post; 'threaded' mode
 *  (grant/progress) stays silent without a thread — never spams the
 *  channel. Always fire-and-forget. */
function announce(
  slack: SlackLike,
  opts: { ref?: { channel: string; ts: string }; originalText?: string; line: string; mode: 'ladder' | 'threaded'; securityChannel: string },
): void {
  const fallback = opts.mode === 'ladder' ? () => postFollowUp(slack, opts.securityChannel, opts.line) : undefined;
  if (opts.ref && slack.updateMessage) {
    void slack
      .updateMessage(opts.ref.channel, opts.ref.ts, `${opts.originalText ?? ''}\n\n${opts.line}`)
      .catch(() => fallback?.());
    return;
  }
  if (opts.ref && slack.postReply) {
    void slack.postReply(opts.ref.channel, opts.ref.ts, opts.line).catch(() => fallback?.());
    return;
  }
  fallback?.();
}

/** Lifecycle re-render on the rich ladder: full card update in place when
 *  the client can, else the text ladder (announce), else standalone. */
export function renderLifecycleUpdate(
  slack: SlackLike,
  view: ApprovalCardView,
  opts: { ref?: { channel: string; ts: string }; originalText?: string; securityChannel: string },
): void {
  const line = renderLifecycleLine(view);
  const mode = view.status === 'granted' || view.status === 'executed' || view.status === 'pending' ? 'threaded' : 'ladder';
  if (opts.ref && slack.updateRichMessage) {
    void slack.updateRichMessage(opts.ref.channel, opts.ref.ts, renderApprovalCard(view)).catch(() =>
      announce(slack, { ref: opts.ref, originalText: opts.originalText, line, mode, securityChannel: opts.securityChannel }),
    );
    return;
  }
  announce(slack, { ref: opts.ref, originalText: opts.originalText, line, mode, securityChannel: opts.securityChannel });
}

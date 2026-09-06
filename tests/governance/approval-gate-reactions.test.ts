import { describe, it, expect } from 'vitest';
import { ApprovalGate, type SlackLike } from '../../src/governance/approval-gate';
import type { Decision, ProposedAction } from '../../src/governance/decision';

const decision: Decision = { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] };
const action: ProposedAction = { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } };

interface PostedRef {
  channel: string;
  ts: string;
  text: string;
}

/** Full-capability fake: records posted message refs like a bot-token client. */
class RefSlack implements SlackLike {
  readonly posted: PostedRef[] = [];
  private seq = 0;
  async postMessage(channel: string, text: string): Promise<void> {
    this.posted.push({ channel, ts: '', text });
  }
  async postMessageWithRef(channel: string, text: string): Promise<{ channel: string; ts: string }> {
    const ts = '1700000000.' + String(++this.seq).padStart(6, '0');
    this.posted.push({ channel, ts, text });
    return { channel, ts };
  }
}

/** Webhook-era fake: can post but cannot resolve a message ref. */
class WebhookSlack implements SlackLike {
  readonly posted: PostedRef[] = [];
  async postMessage(channel: string, text: string): Promise<void> {
    this.posted.push({ channel, ts: '', text });
  }
}

const gateWith = (slack: SlackLike, approverCount = 2): ApprovalGate =>
  new ApprovalGate({ slack, securityChannel: '#sec', approverCount });

describe('ApprovalGate emoji reactions', () => {
  it('correlates a reaction on the posted message to its approval and grants M-of-N', async () => {
    const slack = new RefSlack();
    const gate = gateWith(slack);
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    const msg = slack.posted[0];
    expect(msg?.ts).not.toBe('');

    // First 🛡️ from an admin: one of two required signatures.
    const first = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U1', userRole: 'admin', channel: msg?.channel, ts: msg?.ts });
    expect(first).toMatchObject({ matched: true, approvalId, status: 'pending', signatures: 1 });

    // A DIFFERENT admin reacting 🛡️ on the same message completes M-of-N.
    const second = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U2', userRole: 'admin', channel: msg?.channel, ts: msg?.ts });
    expect(second).toMatchObject({ matched: true, approvalId, status: 'granted', signatures: 2 });
    expect(gate.status(approvalId)?.status).toBe('granted');
  });

  it('dedupes the same user reacting twice (one human, one vote)', async () => {
    const slack = new RefSlack();
    const gate = gateWith(slack);
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    const msg = slack.posted[0];

    const once = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U1', userRole: 'admin', channel: msg?.channel, ts: msg?.ts });
    const twice = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U1', userRole: 'admin', channel: msg?.channel, ts: msg?.ts });
    expect(once).toMatchObject({ signatures: 1 });
    expect(twice).toMatchObject({ signatures: 1, approvalId });
  });

  it('role-gates: reactions map to roles, and a viewer cannot satisfy an admin signature', async () => {
    const slack = new RefSlack();
    const gate = gateWith(slack);
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    const msg = slack.posted[0];

    const viewer = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U1', userRole: 'viewer', channel: msg?.channel, ts: msg?.ts });
    expect(viewer).toMatchObject({ matched: true, accepted: false, reason: expect.stringMatching(/role/i) });
    expect(gate.status(approvalId)?.signatures).toBe(0);

    const engineer = await gate.handleReaction({ type: 'reaction_added', reaction: '🔧', userId: 'U2', userRole: 'engineer', channel: msg?.channel, ts: msg?.ts });
    expect(engineer).toMatchObject({ matched: true, accepted: true, signatures: 1 });
  });

  it('❌ denies the approval; ✅ counts as a low-privilege approve', async () => {
    const slack = new RefSlack();
    const denyGate = gateWith(slack);
    const a = await denyGate.request({ policyId: 'p1', decision, action });
    await denyGate.handleReaction({ type: 'reaction_added', reaction: '❌', userId: 'U1', userRole: 'admin', channel: slack.posted[0]?.channel, ts: slack.posted[0]?.ts });
    expect(denyGate.status(a.approvalId)?.status).toBe('denied');

    const okSlack = new RefSlack();
    const okGate = gateWith(okSlack);
    const b = await okGate.request({ policyId: 'p1', decision, action });
    await okGate.handleReaction({ type: 'reaction_added', reaction: '✅', userId: 'U1', userRole: 'viewer', channel: okSlack.posted[0]?.channel, ts: okSlack.posted[0]?.ts });
    expect(okGate.status(b.approvalId)?.signatures).toBe(1);
  });

  it('falls back to the single pending approval when the ref is unknown (webhook posters)', async () => {
    const slack = new RefSlack();
    const gate = gateWith(slack);
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    // Reactions carry refs the webhook-era gate never recorded.
    const r = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U1', userRole: 'admin', channel: '#sec', ts: '9999.000001' });
    expect(r).toMatchObject({ matched: true, approvalId, accepted: true });
  });

  it('with multiple pending approvals, an unrecorded ref is ambiguous and NOT matched', async () => {
    const slack = new RefSlack();
    const gate = gateWith(slack);
    await gate.request({ policyId: 'p1', decision, action });
    await gate.request({ policyId: 'p1', decision, action });

    const r = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U1', userRole: 'admin', channel: '#sec', ts: '9999.000001' });
    expect(r).toMatchObject({ matched: false, reason: expect.stringMatching(/ambiguous/i) });
  });

  it('removals, unknown reactions, and reaction_removed events are ignored', async () => {
    const slack = new RefSlack();
    const gate = gateWith(slack);
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    const ref = { channel: slack.posted[0]?.channel, ts: slack.posted[0]?.ts };

    const removed = await gate.handleReaction({ type: 'reaction_removed', reaction: '🛡️', userId: 'U1', userRole: 'admin', ...ref });
    expect(removed).toMatchObject({ matched: false, reason: expect.stringMatching(/removal/i) });

    const unknown = await gate.handleReaction({ type: 'reaction_added', reaction: '🎉', userId: 'U1', userRole: 'admin', ...ref });
    expect(unknown).toMatchObject({ matched: true, accepted: false, reason: expect.stringMatching(/reaction/i) });
    expect(gate.status(approvalId)?.signatures).toBe(0);
  });

  it('rejecting roles (guest) never counts, and non-approved/denied approvals ignore late reactions', async () => {
    const slack = new RefSlack();
    const gate = gateWith(slack);
    const a = await gate.request({ policyId: 'p1', decision, action });
    await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U1', userRole: 'guest', channel: slack.posted[0]?.channel, ts: slack.posted[0]?.ts });
    expect(gate.status(a.approvalId)?.signatures).toBe(0);

    await gate.deny(a.approvalId);
    const late = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U2', userRole: 'admin', channel: slack.posted[0]?.channel, ts: slack.posted[0]?.ts });
    expect(late).toMatchObject({ accepted: false });
  });

  it('a webhook-era SlackLike (no postMessageWithRef) still works end to end', async () => {
    const slack = new WebhookSlack();
    const gate = gateWith(slack);
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0]?.ts).toBe('');

    const r = await gate.handleReaction({ type: 'reaction_added', reaction: '🛡️', userId: 'U1', userRole: 'admin', channel: '#sec', ts: 'anything' });
    expect(r).toMatchObject({ matched: true, approvalId, accepted: true });
  });
});

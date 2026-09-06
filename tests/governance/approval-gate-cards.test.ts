import { describe, it, expect } from 'vitest';
import { ApprovalGate, type SlackLike } from '../../src/governance/approval-gate';
import type { Decision, ProposedAction } from '../../src/governance/decision';

const decision: Decision = { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] };
const action: ProposedAction = { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } };

interface RichMsg {
  text: string;
  attachments?: unknown[];
  blocks?: unknown[];
}

/** Bot-token-shaped fake with full rich capability (cards + updates). */
class RichSlack implements SlackLike {
  readonly postedMsgs: Array<RichMsg & { channel?: string }> = [];
  readonly updatedMsgs: Array<{ channel: string; ts: string; msg: RichMsg }> = [];
  private seq = 0;
  async postMessage(channel: string, text: string): Promise<void> {
    this.postedMsgs.push({ channel, text });
  }
  async postMessageWithRef(channel: string, text: string): Promise<{ channel: string; ts: string }> {
    this.postedMsgs.push({ channel, text });
    return { channel, ts: '1700000000.' + String(++this.seq).padStart(6, '0') };
  }
  async postRichMessage(channel: string, msg: RichMsg): Promise<{ channel: string; ts: string }> {
    this.postedMsgs.push({ ...msg, channel });
    return { channel, ts: '1700000000.' + String(++this.seq).padStart(6, '0') };
  }
  async updateRichMessage(channel: string, ts: string, msg: RichMsg): Promise<void> {
    this.updatedMsgs.push({ channel, ts, msg });
  }
}

describe('ApprovalGate Block Kit cards', () => {
  it('rich-capable clients get a colored pending card with approve/deny buttons', async () => {
    const slack = new RichSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    expect(slack.postedMsgs).toHaveLength(1);
    const card = slack.postedMsgs[0] as { text: string; attachments?: Array<{ color?: string; blocks?: Array<{ type?: string; elements?: Array<{ action_id?: string }> }> }> };
    const att = card.attachments?.[0];
    expect(att?.color).toBe('warning');
    const actions = att?.blocks?.find((b) => b['type'] === 'actions');
    const ids = (actions?.elements ?? []).map((b) => String(b['action_id']));
    expect(ids).toContain('approval:approve:' + approvalId);
    expect(ids).toContain('approval:deny:' + approvalId);
    // Fallback text survives for notifications / plain clients.
    expect(card.text).toContain('execute_runbook_script');
    expect(slack.updatedMsgs).toHaveLength(0);
  });

  it('grant re-renders the card green with the count and no buttons', async () => {
    const slack = new RichSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    gate.sign(approvalId, 'admin', 'alice');
    gate.sign(approvalId, 'admin', 'bob');
    expect(slack.updatedMsgs.length).toBeGreaterThanOrEqual(1);
    const final = slack.updatedMsgs[slack.updatedMsgs.length - 1];
    const att = final?.msg.attachments?.[0] as { color?: string; blocks?: Array<{ type?: string }> };
    expect(att.color).toBe('good');
    expect(att.blocks?.some((b) => b['type'] === 'actions')).toBe(false);
    expect(final?.msg.text).toMatch(/GRANTED/);
    expect(final?.msg.text).toContain('2/2');
  });

  it('progress re-renders the still-pending card with the signature count', async () => {
    const slack = new RichSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    gate.sign(approvalId, 'admin', 'alice');
    const progress = slack.updatedMsgs[0];
    const att = progress?.msg.attachments?.[0] as { color?: string; blocks?: Array<{ type?: string }> };
    expect(att.color).toBe('warning'); // still pending
    expect(JSON.stringify(att.blocks)).toContain('1/2');
    // Buttons remain while pending.
    expect(att.blocks?.some((b) => b['type'] === 'actions')).toBe(true);
  });

  it('deny re-renders red and timeout amber, both without buttons', async () => {
    let now = 1_000_000;
    const slack = new RichSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', defaultTimeoutMs: 60_000, now: () => now });
    const a = await gate.request({ policyId: 'p1', decision, action });
    gate.deny(a.approvalId);
    const denied = slack.updatedMsgs[slack.updatedMsgs.length - 1];
    expect((denied?.msg.attachments?.[0] as { color?: string }).color).toBe('danger');
    expect((denied?.msg.attachments?.[0] as { blocks?: Array<{ type?: string }> }).blocks?.some((b) => b['type'] === 'actions')).toBe(false);

    const b = await gate.request({ policyId: 'p1', decision, action });
    now += 61_000;
    gate.checkTimeouts();
    const timedOut = slack.updatedMsgs[slack.updatedMsgs.length - 1];
    expect((timedOut?.msg.attachments?.[0] as { color?: string }).color).toBe('warning');
    expect(timedOut?.msg.text).toMatch(/TIMED OUT/);
  });

  it('text-mode clients keep the exact previous behavior (no rich calls)', async () => {
    const posted: Array<{ channel: string; text: string }> = [];
    const slack: SlackLike = {
      async postMessage(channel, text) {
        posted.push({ channel, text });
      },
    };
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    gate.sign(approvalId, 'admin'); // pending progress → threaded-only → silent
    gate.deny(approvalId); // deny → standalone post (old contract)
    expect(posted).toHaveLength(2); // request + standalone DENIED
    expect(String(posted[1]?.text)).toMatch(/DENIED/);
  });
});

describe('ApprovalGate button actions', () => {
  it('approve clicks grant M-of-N with role gating and per-user dedupe', async () => {
    const slack = new RichSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    const click = (userId: string, userRole?: 'admin' | 'engineer' | 'viewer' | 'guest') =>
      gate.handleAction({ actionId: 'approval:approve:' + approvalId, userId, userRole });

    const guest = await click('U-guest', 'guest');
    expect(guest).toMatchObject({ matched: true, accepted: false, reason: expect.stringMatching(/role/i) });
    const anon = await click('U-anon', undefined);
    expect(anon.accepted).toBe(false);

    const first = await click('U1', 'admin');
    expect(first).toMatchObject({ matched: true, accepted: true, status: 'pending', signatures: 1 });
    const dupe = await click('U1', 'admin');
    expect(dupe).toMatchObject({ signatures: 1 });
    // Approve buttons demand admin — an engineer's click is correctly refused.
    const eng = await click('U-eng', 'engineer');
    expect(eng).toMatchObject({ accepted: false });
    const second = await click('U2', 'admin');
    expect(second).toMatchObject({ accepted: true, status: 'granted', signatures: 2 });
  });

  it('deny click denies; unknown ids are not matched; resolved approvals ignore clicks', async () => {
    const slack = new RichSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    await gate.handleAction({ actionId: 'approval:deny:' + approvalId, userId: 'U1', userRole: 'viewer' });
    expect(gate.status(approvalId)?.status).toBe('denied');

    const late = await gate.handleAction({ actionId: 'approval:approve:' + approvalId, userId: 'U2', userRole: 'admin' });
    expect(late).toMatchObject({ matched: true, accepted: false, status: 'denied' });

    const unknown = await gate.handleAction({ actionId: 'approval:approve:nope', userId: 'U2', userRole: 'admin' });
    expect(unknown).toMatchObject({ matched: false });
    const alien = await gate.handleAction({ actionId: 'totally:other', userId: 'U2', userRole: 'admin' });
    expect(alien).toMatchObject({ matched: false });
  });

  it('the embedded approvalId correlates the click even with several pending', async () => {
    const slack = new RichSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    const a = await gate.request({ policyId: 'p1', decision, action });
    const b = await gate.request({ policyId: 'p1', decision, action });

    await gate.handleAction({ actionId: 'approval:approve:' + b.approvalId, userId: 'U1', userRole: 'admin' });
    expect(gate.status(b.approvalId)?.status).toBe('granted');
    expect(gate.status(a.approvalId)?.status).toBe('pending');
  });
});

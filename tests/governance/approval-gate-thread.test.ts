import { describe, it, expect } from 'vitest';
import { ApprovalGate, type SlackLike, type RichMessage } from '../../src/governance/approval-gate';
import type { Decision, ProposedAction } from '../../src/governance/decision';

const decision: Decision = { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] };
const action: ProposedAction = { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } };

class Gate implements SlackLike {
  readonly posted: Array<{ channel: string; text: string; threadTs?: string }> = [];
  readonly cards: Array<{ channel: string; message: RichMessage; threadTs?: string }> = [];
  async postMessage(channel: string, text: string): Promise<void> {
    this.posted.push({ channel, text });
  }
  async postRichMessage(channel: string, message: RichMessage): Promise<{ channel: string; ts: string }> {
    this.cards.push({ channel, message });
    return { channel, ts: `${1000 + this.cards.length}` };
  }
  async postRichThreadMessage(channel: string, threadTs: string, message: RichMessage): Promise<{ channel: string; ts: string }> {
    this.cards.push({ channel, message, threadTs });
    return { channel, ts: `${2000 + this.cards.length}` };
  }
}

describe('ApprovalGate thread routing', () => {
  it('request({thread}) posts the card in-thread under the given message ref', async () => {
    const slack = new Gate();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    await gate.request({ policyId: 'p1', decision, action, thread: { channel: '#meet', ts: '1700000000.1' } });
    expect(slack.cards.length).toBe(1);
    expect(slack.cards[0]!.channel).toBe('#meet');
    expect((slack.cards[0]!.message as unknown as { threadTs?: string }).threadTs ?? slack.cards[0]!.threadTs).toBe('1700000000.1');
  });

  it('without a thread, the card lands on the security channel as before', async () => {
    const slack = new Gate();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    await gate.request({ policyId: 'p1', decision, action });
    expect(slack.cards[0]!.channel).toBe('#sec');
  });

  it('lifecycle updates follow the thread ref, not the security channel', async () => {
    const slack = new Gate();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action, thread: { channel: '#meet', ts: '1700000000.1' } });
    gate.sign(approvalId, 'admin', 'U1');
    gate.sign(approvalId, 'admin', 'U2');
    // The update lands on the thread ref (the rich update path records the ref).
    expect(gate.status(approvalId)?.status).toBe('granted');
  });

  it('deliveries map keys on the thread ref so reactions correlate to the right approval', async () => {
    const slack = new Gate();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action, thread: { channel: 'C123', ts: '1700000000.1' } });
    const r = await gate.handleReaction({ type: 'reaction_added', reaction: 'white_check_mark', userId: 'U1', userRole: 'admin', channel: 'C123', ts: '1700000000.1' });
    expect(r.matched).toBe(true);
    expect(r.approvalId).toBe(approvalId);
    expect(r.accepted).toBe(true);
  });
});

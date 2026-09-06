import { describe, it, expect } from 'vitest';
import { ApprovalGate, type SlackLike } from '../../src/governance/approval-gate';
import type { Decision, ProposedAction } from '../../src/governance/decision';

const decision: Decision = { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] };
const action: ProposedAction = { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } };

/** Records synchronously so fire-and-forget follow-ups are assertable. */
class FakeSlack implements SlackLike {
  readonly posted: Array<{ channel: string; text: string }> = [];
  failNext = false;
  async postMessage(channel: string, text: string): Promise<void> {
    if (this.failNext) throw new Error('slack down');
    this.posted.push({ channel, text });
  }
}

describe('ApprovalGate lifecycle follow-ups', () => {
  it('posts a follow-up when an approval is denied', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    gate.deny(approvalId);
    expect(slack.posted).toHaveLength(2);
    expect(slack.posted[1]?.text).toMatch(/DENIED/i);
    expect(slack.posted[1]?.text).toContain('will not');
  });

  it('posts a follow-up when an approval times out (and not before)', async () => {
    let now = 1_000_000;
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', defaultTimeoutMs: 60_000, now: () => now });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    now += 59_999;
    expect(gate.checkTimeouts()).toEqual([]);
    expect(slack.posted).toHaveLength(1); // request only — no premature follow-up

    now += 2;
    expect(gate.checkTimeouts()).toEqual([approvalId]);
    expect(slack.posted).toHaveLength(2);
    expect(slack.posted[1]?.text).toMatch(/TIMED OUT/i);
    expect(slack.posted[1]?.text).toContain('will not');
    // Second sweep must not double-post.
    expect(gate.checkTimeouts()).toEqual([]);
    expect(slack.posted).toHaveLength(2);
  });

  it('honors request-level timeoutMs over the gate default', () => {
    let now = 1_000_000;
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', defaultTimeoutMs: 60_000, now: () => now });
    void gate.request({ policyId: 'p1', decision, action, timeoutMs: 5_000 });
    now += 6_000;
    expect(gate.checkTimeouts()).toHaveLength(1);
  });

  it('follow-up delivery failure never breaks deny() or checkTimeouts()', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    slack.failNext = true;
    // deny() stays synchronous (fire-and-forget follow-up): a Slack outage
    // must not break the governance path.
    expect(() => gate.deny(approvalId)).not.toThrow();
    expect(gate.status(approvalId)?.status).toBe('denied');
    // Give the rejected fire-and-forget promise a microtask to surface,
    // then confirm it was swallowed.
    await new Promise((r) => setTimeout(r, 10));
  });

  it('granted approvals post no follow-up', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    gate.sign(approvalId, 'admin');
    expect(slack.posted).toHaveLength(1);
  });
});

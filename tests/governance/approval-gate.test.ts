import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalGate, type SlackLike } from '../../src/governance/approval-gate';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { Decision, ProposedAction } from '../../src/governance/decision';

class FakeSlack implements SlackLike {
  posted: Array<{ channel: string; text: string }> = [];
  async postMessage(channel: string, text: string): Promise<void> {
    this.posted.push({ channel, text });
  }
}

const decision: Decision = { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] };
const action: ProposedAction = { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'approvalgate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ApprovalGate', () => {
  it('posts a Slack message and tracks approvals until M-of-N', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0]?.channel).toBe('#sec');
    expect(slack.posted[0]?.text).toContain('execute_runbook_script');

    expect(gate.sign(approvalId, 'admin').status).toBe('pending');
    expect(gate.sign(approvalId, 'admin').status).toBe('granted');
  });

  it('counts distinct signers when signerId is provided (no self-approval twice)', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    expect(gate.sign(approvalId, 'admin', 'alice').status).toBe('pending');
    expect(gate.sign(approvalId, 'admin', 'alice').status).toBe('pending'); // deduped
    expect(gate.sign(approvalId, 'admin', 'bob').status).toBe('granted');
  });

  it('denies on explicit deny', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    expect(gate.deny(approvalId).status).toBe('denied');
  });

  it('signing after deny does not resurrect the approval', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    gate.deny(approvalId);
    expect(gate.sign(approvalId, 'admin').status).toBe('denied');
  });

  it('times out pending approvals and reports the timeout', async () => {
    let now = 1_000_000;
    const slack = new FakeSlack();
    const gate = new ApprovalGate({
      slack,
      securityChannel: '#sec',
      approverCount: 2,
      now: () => now,
      defaultTimeoutMs: 60_000,
    });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    now += 59_999;
    expect(gate.checkTimeouts()).toEqual([]);
    now += 2; // past the 60s window
    expect(gate.checkTimeouts()).toEqual([approvalId]);
    expect(gate.status(approvalId)?.status).toBe('timeout');
    // signing a timed-out approval does not grant it
    expect(gate.sign(approvalId, 'admin').status).toBe('timeout');
  });

  it('emits approval_request and approval_granted events when an EventLog is wired', async () => {
    const slack = new FakeSlack();
    const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1, eventLog: log });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    gate.sign(approvalId, 'admin', 'alice');
    // flush the fire-and-forget audit writes
    await new Promise((r) => setTimeout(r, 20));

    const kinds: string[] = [];
    for await (const e of log.query({ correlationId: approvalId })) kinds.push(e.kind);
    expect(kinds).toContain('approval_request');
    expect(kinds).toContain('approval_granted');
  });

  it('rejects signing or denying an unknown approvalId', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec' });
    expect(() => gate.sign('nope', 'admin')).toThrow(/unknown approvalId/);
    expect(() => gate.deny('nope')).toThrow(/unknown approvalId/);
  });
});

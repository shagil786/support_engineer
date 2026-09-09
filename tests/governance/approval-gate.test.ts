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
  it('listPending: lists queue-worthy entries with tool/args/progress; timed-out leaves; granted stays until executed', async () => {
    let t = 1_000_000;
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2, now: () => t, defaultTimeoutMs: 5_000 });
    const a = await gate.request({ policyId: 'p1', decision, action });
    const b = await gate.request({ policyId: 'p2', decision, action: { tool: 'jira_create_issue', args: { summary: 'x' } } });

    let list = gate.listPending();
    expect(list).toHaveLength(2);
    const first = list[0];
    if (!first) throw new Error('expected a listed approval');
    expect(first.approvalId).toBe(a.approvalId);
    expect(first.tool).toBe('execute_runbook_script');
    expect(first.args).toEqual({ script_name: 'restart-all' });
    expect(first.reason).toBe('destructive');
    expect(first.signatures).toBe(0);
    expect(first.required).toBe(2);
    expect(first.expires).toBe(true);
    expect(first.status).toBe('pending');

    // Grant one fully: it STAYS in the queue with status 'granted' —
    // vanishing would strand the operator (execute is id-addressed and the
    // id came from the staged response).
    gate.sign(a.approvalId, 'admin');
    gate.sign(a.approvalId, 'admin2');
    // Timeout the other AT LIST TIME — no one called checkTimeouts, but the
    // deadline passed, so the queue must not show it at all.
    t += 6_000;
    list = gate.listPending();
    expect(list).toHaveLength(1);
    expect(list[0]?.approvalId).toBe(a.approvalId);
    expect(list[0]?.status).toBe('granted');
    // checkTimeouts agrees: only the timed-out one expires.
    expect(gate.checkTimeouts()).toEqual([b.approvalId]);
  });

  it('onQueueChange: fires on request, each listing-visible signature, grant, deny, execute; unsubscribe silences it', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    let changes = 0;
    const off = gate.onQueueChange(() => {
      changes += 1;
    });
    const { approvalId } = await gate.request({ policyId: 'p', decision, action });
    expect(changes).toBe(1); // staged
    gate.sign(approvalId, 'admin');
    expect(changes).toBe(2); // signature count is listing-visible (1/2)
    gate.sign(approvalId, 'admin2');
    expect(changes).toBe(3); // grant → pending becomes granted
    gate.markExecuted(approvalId);
    expect(changes).toBe(4); // executed → leaves the queue
    off();
    const other = await gate.request({ policyId: 'p2', decision, action });
    gate.deny(other.approvalId);
    expect(changes).toBe(4); // unsubscribed: silence
  });

  it('onQueueChange: a throwing listener never breaks the mutation path', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    gate.onQueueChange(() => {
      throw new Error('listener bug');
    });
    const { approvalId } = await gate.request({ policyId: 'p', decision, action });
    const snap = gate.sign(approvalId, 'admin');
    expect(snap.status).toBe('granted'); // mutation succeeded despite the listener
  });

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

  it('emits approval_denied when a pending approval is denied', async () => {
    const slack = new FakeSlack();
    const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2, eventLog: log });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    gate.deny(approvalId);
    await new Promise((r) => setTimeout(r, 20));

    const kinds: string[] = [];
    for await (const e of log.query({ correlationId: approvalId })) kinds.push(e.kind);
    expect(kinds).toContain('approval_denied');
  });

  it('rejects signing or denying an unknown approvalId', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec' });
    expect(() => gate.sign('nope', 'admin')).toThrow(/unknown approvalId/);
    expect(() => gate.deny('nope')).toThrow(/unknown approvalId/);
  });
});

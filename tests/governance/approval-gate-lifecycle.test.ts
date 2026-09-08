import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalGate, type SlackLike } from '../../src/governance/approval-gate';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { Decision, ProposedAction } from '../../src/governance/decision';

const decision: Decision = { effect: 'require_approval', reason: 'destructive', policyIds: ['p1'] };
const action: ProposedAction = { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'approvalgate-lc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Records synchronously so fire-and-forget follow-ups are assertable. */
class FakeSlack implements SlackLike {
  readonly posted: Array<{ channel: string; text: string }> = [];
  failNext = false;
  async postMessage(channel: string, text: string): Promise<void> {
    if (this.failNext) throw new Error('slack down');
    this.posted.push({ channel, text });
  }
}

interface Update { channel: string; ts: string; text: string }
interface Reply { channel: string; threadTs: string; text: string }

/** Bot-token-shaped fake: resolves refs and can update or thread-reply. */
class BotSlack implements SlackLike {
  readonly posted: Array<{ channel: string; text: string }> = [];
  readonly updates: Update[] = [];
  readonly replies: Reply[] = [];
  private seq = 0;
  constructor(
    private readonly withUpdate = true,
    private readonly withReply = false,
  ) {
    // Emulate ABSENCE (not failure): the gate branches on capability.
    if (!withUpdate) (this as unknown as { updateMessage?: unknown }).updateMessage = undefined;
    if (!withReply) (this as unknown as { postReply?: unknown }).postReply = undefined;
  }
  async postMessage(channel: string, text: string): Promise<void> {
    this.posted.push({ channel, text });
  }
  async postMessageWithRef(channel: string, text: string): Promise<{ channel: string; ts: string }> {
    const ts = '1700000000.' + String(++this.seq).padStart(6, '0');
    this.posted.push({ channel, text });
    return { channel, ts };
  }
  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    if (!this.withUpdate) throw new Error('updateMessage not implemented');
    this.updates.push({ channel, ts, text });
  }
  async postReply(channel: string, ts: string, text: string): Promise<void> {
    if (!this.withReply) throw new Error('postReply not implemented');
    this.replies.push({ channel, threadTs: ts, text });
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

  it('sweepOrphans closes logged requests with no terminal event', async () => {
    const log = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
    const now = 2_000_000;
    const gate = new ApprovalGate({ slack: new FakeSlack(), securityChannel: '#sec', approverCount: 2, eventLog: log, now: () => now });

    // History in the spine: two pre-boot requests, one terminal (denied), one orphaned.
    await log.append({ correlationId: 'old-denied', ts: 1_000_000, layer: 'governance', source: 'slack', kind: 'approval_request', approvalId: 'old-denied', policyId: 'p1', approver_count: 2 });
    await log.append({ correlationId: 'old-denied', ts: 1_000_100, layer: 'governance', source: 'slack', kind: 'approval_denied', approvalId: 'old-denied' });
    await log.append({ correlationId: 'old-orphan', ts: 1_500_000, layer: 'governance', source: 'slack', kind: 'approval_request', approvalId: 'old-orphan', policyId: 'p1', approver_count: 2 });

    const swept = await gate.sweepOrphans();
    expect(swept).toEqual(['old-orphan']);

    const kinds: string[] = [];
    for await (const e of log.query({ correlationId: 'old-orphan' })) kinds.push(e.kind);
    expect(kinds).toContain('approval_timeout');
  });

  it('sweepOrphans ignores this-boot activity and returns [] without an event log', async () => {
    const now = 2_000_000;
    // No eventLog wired → no-op.
    expect(await new ApprovalGate({ slack: new FakeSlack(), securityChannel: '#sec' }).sweepOrphans()).toEqual([]);

    const log = new JsonlFileEventLog({ baseDir: join(dir, 'events-2') });
    const gate = new ApprovalGate({ slack: new FakeSlack(), securityChannel: '#sec', approverCount: 2, eventLog: log, now: () => now });
    // A post-boot request (ts >= boot) is live work, not an orphan.
    await log.append({ correlationId: 'live', ts: now, layer: 'governance', source: 'slack', kind: 'approval_request', approvalId: 'live', policyId: 'p1', approver_count: 2 });
    expect(await gate.sweepOrphans()).toEqual([]);
    // Idempotent: a second sweep over the same spine sweeps nothing new.
    expect(await gate.sweepOrphans()).toEqual([]);
  });

  it('granted approvals post no follow-up', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    gate.sign(approvalId, 'admin');
    expect(slack.posted).toHaveLength(1);
  });

  it('UPDATES the original message on deny and timeout (no standalone post)', async () => {
    let now = 1_000_000;
    const slack = new BotSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', defaultTimeoutMs: 60_000, now: () => now });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    const ref = { channel: '#sec', ts: '1700000000.000001' };

    gate.deny(approvalId);
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]).toMatchObject({ ...ref, text: expect.stringMatching(/DENIED/) });
    expect(slack.posted).toHaveLength(1); // request only — never a second post

    const b = await gate.request({ policyId: 'p1', decision, action });
    now += 61_000; // past the SECOND request's window
    gate.checkTimeouts();
    expect(slack.updates).toHaveLength(2);
    expect(slack.updates[1]).toMatchObject({ channel: '#sec', ts: '1700000000.000002', text: expect.stringMatching(/TIMED OUT/) });
    void b;
  });

  it('UPDATES the original message on grant with the signature count', async () => {
    const slack = new BotSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    gate.sign(approvalId, 'admin', 'alice');
    gate.sign(approvalId, 'admin', 'bob');
    // Two sequential edits: alice's 1/2 progress, then the grant on bob.
    expect(slack.updates).toHaveLength(2);
    expect(slack.updates[0]?.text).toContain('1/2');
    expect(slack.updates[1]?.text).toMatch(/GRANTED/);
    expect(slack.updates[1]?.text).toContain('2/2');
    expect(slack.posted).toHaveLength(1);
  });

  it('shows signature progress on the original message while still pending', async () => {
    const slack = new BotSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    gate.sign(approvalId, 'admin', 'alice');
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]?.text).toContain('1/2');
    expect(slack.updates[0]?.text).toMatch(/pending/i);
    // Duplicate signature: no change, no redundant update.
    gate.sign(approvalId, 'admin', 'alice');
    expect(slack.updates).toHaveLength(1);
  });

  it('falls back to a THREAD REPLY when update is unavailable but reply is', async () => {
    const slack = new BotSlack(false, true);
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });

    gate.deny(approvalId);
    expect(slack.replies).toHaveLength(1);
    expect(slack.replies[0]).toMatchObject({ channel: '#sec', threadTs: '1700000000.000001', text: expect.stringMatching(/DENIED/) });
    expect(slack.posted).toHaveLength(1);
  });

  it('ref-less posters (webhook era): grant silent, deny standalone', async () => {
    const slack = new FakeSlack();
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    const a = await gate.request({ policyId: 'p1', decision, action });
    gate.sign(a.approvalId, 'admin');
    expect(slack.posted).toHaveLength(1); // grant: silent without thread capability
    const b = await gate.request({ policyId: 'p1', decision, action });
    expect(slack.posted).toHaveLength(2); // request b's own message
    gate.deny(b.approvalId);
    expect(slack.posted).toHaveLength(3); // + standalone DENIED, as before
    expect(slack.posted[2]?.text).toMatch(/DENIED/);
  });

  it('with a ref but no update/reply capability, deny degrades to a standalone post', async () => {
    const slack = new BotSlack();
    (slack as unknown as { updateMessage?: unknown }).updateMessage = undefined;
    (slack as unknown as { postReply?: unknown }).postReply = undefined;
    const gate = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 1 });
    const { approvalId } = await gate.request({ policyId: 'p1', decision, action });
    gate.deny(approvalId);
    expect(slack.updates).toHaveLength(0);
    expect(slack.replies).toHaveLength(0);
    expect(slack.posted).toHaveLength(2); // request + standalone DENIED
    expect(slack.posted[1]?.text).toMatch(/DENIED/);
  });
});

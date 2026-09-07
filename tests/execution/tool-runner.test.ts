import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRunner } from '../../src/execution/tool-runner';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { SafetyNet } from '../../src/governance/safety-net';
import type { GovernedAction, Decision } from '../../src/governance/decision';
import type { ToolName } from '../../src/support-voice-agent/tools/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toolrunner-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const allowDecision: Decision = { effect: 'allow', reason: 'test', policyIds: ['test'] };

const execCtx = (over: Partial<Parameters<ToolRunner['run']>[1]> = {}) => ({
  correlationId: 'c1',
  speakerId: 'u1',
  tokens: { prompt: 0, completion: 0 },
  candidateOutput: '',
  toolCallHistory: [] as Array<{ tool: ToolName; args: unknown }>,
  ...over,
});

describe('ToolRunner', () => {
  it('rejects a denied GovernedAction without running the tool', async () => {
    let calls = 0;
    const runner = new ToolRunner({
      context: { jiraClient: { createIssue: async () => { calls++; return { key: 'X', id: '1' }; } } },
    });
    const ga: GovernedAction = { kind: 'deny', decision: { ...allowDecision, effect: 'deny', reason: 'PII guard' } };
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('PII guard');
    expect(calls).toBe(0);
  });

  it('rejects an unresolved request_approval', async () => {
    const runner = new ToolRunner({ context: {} });
    const ga: GovernedAction = {
      kind: 'request_approval',
      decision: allowDecision,
      action: { tool: 'execute_runbook_script', args: {} },
      approvalId: 'a1',
    };
    await expect(runner.run(ga, execCtx())).rejects.toThrow(/must be resolved/);
  });

  it('validates args against the tool schema', async () => {
    const runner = new ToolRunner({ context: {} });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'jira_create_issue', args: { summary: '', issue_type: 'Bug' } },
    };
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/invalid args/i);
  });

  it('emits a tool_call event even when args fail schema validation (audit trail completeness)', async () => {
    // Regression: the schema-invalid early return skipped emitEvent, so an
    // agent's malformed planned call vanished from history — the learning
    // loop and any auditor saw a failure with no visible cause.
    const log = new JsonlFileEventLog({ baseDir: dir });
    const runner = new ToolRunner({ context: {}, eventLog: log });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'query_logs', args: { query: 'wrong field name' } },
    };
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(false);
    const events: Array<{ kind: string; tool?: string; result?: { error?: string } }> = [];
    for await (const e of log.query({})) events.push(e as never);
    const tc = events.find((e) => e.kind === 'tool_call');
    expect(tc?.tool).toBe('query_logs');
    expect(tc?.result?.error).toMatch(/invalid args/i);
  });

  it('runs a valid execute and emits a tool_call event', async () => {
    const log = new JsonlFileEventLog({ baseDir: dir });
    const runner = new ToolRunner({
      context: { jiraClient: { createIssue: async () => ({ key: 'SUPPORT-1', id: '1' }) } },
      eventLog: log,
    });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } },
    };
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(true);

    const events = [];
    for await (const e of log.query({ correlationId: 'c1' })) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('tool_call');
  });

  it('dedupes by idempotencyKey within the TTL window', async () => {
    let calls = 0;
    const runner = new ToolRunner({
      context: { jiraClient: { createIssue: async () => { calls++; return { key: 'X', id: '1' }; } } },
      idempotencyTtlMs: 60_000,
    });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } },
    };
    const ctx = execCtx({ idempotencyKey: 'dup-1' });
    await runner.run(ga, ctx);
    await runner.run(ga, ctx);
    expect(calls).toBe(1);
  });

  it('lets an expired idempotency entry run again', async () => {
    let calls = 0;
    let t = 1_000_000;
    const runner = new ToolRunner({
      context: { jiraClient: { createIssue: async () => { calls++; return { key: 'X', id: '1' }; } } },
      idempotencyTtlMs: 1_000,
      now: () => t,
    });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } },
    };
    const ctx = execCtx({ idempotencyKey: 'dup-1' });
    await runner.run(ga, ctx);
    t += 2_000;
    await runner.run(ga, ctx);
    expect(calls).toBe(2);
  });

  it('honors a SafetyNet veto without executing', async () => {
    let calls = 0;
    const sn = new SafetyNet({ speakers: () => 'guest' });
    const runner = new ToolRunner({
      context: { runbookProvider: { list: async () => [], run: async () => { calls++; return { ok: true as const, actionId: 'a', output: '' }; } } },
      safetyNet: sn,
    });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'execute_runbook_script', args: { script_name: 'restart-all' } },
    };
    const r = await runner.run(ga, execCtx({ speakerId: 'guest1' }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/SafetyNet veto/);
    expect(calls).toBe(0);
  });

  it('retries when a tool throws (transport failure) and succeeds on a later attempt', async () => {
    let attempts = 0;
    const runner = new ToolRunner({
      context: {
        jiraClient: {
          createIssue: async () => {
            attempts++;
            if (attempts < 3) throw new Error('ECONNRESET');
            return { key: 'SUPPORT-9', id: '9' };
          },
        },
      },
      retryBackoffMs: 1,
      eventLog: new JsonlFileEventLog({ baseDir: dir }),
    });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } },
    };
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(true);
    expect(attempts).toBe(3);

    const events = [];
    for await (const e of new JsonlFileEventLog({ baseDir: dir }).query({ correlationId: 'c1' })) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === 'tool_call' && events[0].attempts).toBe(3);
  });

  it('gives up after maxRetries and returns the failure without throwing', async () => {
    let attempts = 0;
    const runner = new ToolRunner({
      context: { jiraClient: { createIssue: async () => { attempts++; throw new Error('down'); } } },
      maxRetries: 2,
      retryBackoffMs: 1,
    });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } },
    };
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(false);
    expect(attempts).toBe(2);
    expect(r.ok === false && String(r.detail)).toContain('down');
  });

  it('enforces a per-call timeout', async () => {
    const runner = new ToolRunner({
      context: {
        jiraClient: {
          createIssue: () => new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('should not resolve')), 500);
          }),
        },
      },
      callTimeoutMs: 20,
      retryBackoffMs: 1,
      maxRetries: 1,
    });
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } },
    };
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && String(r.detail)).toMatch(/timed out/i);
  });

  it('returns unknown-tool failure without throwing', async () => {
    const runner = new ToolRunner({ context: {} });
    const ga = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'deploy_to_prod', args: {} },
    } as unknown as GovernedAction;
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/unknown tool/);
  });

  it('records tool calls into the shared history for loop detection', async () => {
    const runner = new ToolRunner({
      context: { jiraClient: { createIssue: async () => ({ key: 'X', id: '1' }) } },
    });
    const history: Array<{ tool: ToolName; args: unknown }> = [];
    const ga: GovernedAction = {
      kind: 'execute',
      decision: allowDecision,
      action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } },
    };
    await runner.run(ga, execCtx({ toolCallHistory: history }));
    expect(history).toHaveLength(1);
    expect(history[0]?.tool).toBe('jira_create_issue');
  });

  it('never throws across the boundary for validator failures', async () => {
    const runner = new ToolRunner({ context: {} });
    const spy = vi.fn();
    process.on('unhandledRejection', spy);
    const ga = { kind: 'execute', decision: allowDecision, action: { tool: 'query_logs', args: 'not-an-object' } } as unknown as GovernedAction;
    const r = await runner.run(ga, execCtx());
    expect(r.ok).toBe(false);
    process.off('unhandledRejection', spy);
    expect(spy).not.toHaveBeenCalled();
  });
});

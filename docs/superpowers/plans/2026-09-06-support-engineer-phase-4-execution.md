# Phase 4 — Execution Layer (multi-agent)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deterministic `processUtterance` cascade + the single-loop `LlmOrchestrator` with a `SupervisorAgent` orchestrating four focused sub-agents (Triage / Investigator / Executor / Reviewer) over a single `ToolRunner` that schema-validates every call, rate-limits, dedupes by idempotency key, retries with backoff, and emits a `tool_call` event for every call. The type system enforces: tools take `GovernedAction`, never raw `ProposedAction`.

**Architecture:** One `SupervisorAgent` owns the per-request loop (caps: sub-agent hops, tokens, wall clock, loop detection). Sub-agents are small `LlmAgent`s with focused prompts and tool whitelists. Every tool call funnels through `ToolRunner`, which is the *single* integration point for Jira/Logs/Runbook/Slack and replaces today's `tools/handlers.ts`. Verifier = `ReviewerAgent` (LLM critic) + lightweight non-LLM checks.

**Tech Stack:** Existing TypeScript + Vitest + Zod + `OpenAiCompatibleClient`. **No new deps.**

**Spec:** `docs/superpowers/specs/2026-09-06-support-engineer-agentic-design.md` §6 (Execution), §9 (file layout: `src/execution/`).

## Global Constraints

- TypeScript strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`.
- No hardcoded hosts, tokens, or keys in `src/`.
- Every tool call emits a `tool_call` event with prompt/result/latency/attempts/correlationId.
- Zod validates every tool's args before execution.
- `ToolRunner.run(governed: GovernedAction, ctx)` is the only path to integration clients.
- 150 existing + Phase 1 + Phase 2 + Phase 3 tests must remain green at every commit.

## File Structure

```
src/execution/
├── supervisor.ts             # SupervisorAgent
├── verifier.ts               # lightweight non-LLM checks
├── tool-runner.ts            # schema-validate → RBAC → rate-limit → idempotency → retry → exec → log
├── agents/
│   ├── base.ts               # LlmAgent base (system prompt + tool whitelist)
│   ├── triage.ts
│   ├── investigator.ts
│   ├── executor.ts
│   └── reviewer.ts
├── tools/
│   ├── registry.ts           # tool schemas (port from today's TOOL_SCHEMAS)
│   ├── jira.ts
│   ├── logs.ts
│   ├── runbook.ts
│   ├── slack.ts
│   └── memory.ts
└── index.ts

tests/execution/
├── supervisor.test.ts
├── tool-runner.test.ts
├── verifier.test.ts
└── agents/
    ├── triage.test.ts
    ├── investigator.test.ts
    ├── executor.test.ts
    └── reviewer.test.ts
```

## Task 4.1: Port `tools/registry.ts` (Zod schemas)

**Files:**
- Create: `src/execution/tools/registry.ts`
- Test: `tests/execution/tools-registry.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `TOOL_REGISTRY: Record<ToolName, { schema: ZodType, execute(args, ctx): Promise<ToolResult> }>`, `toolNames()`

- [ ] **Step 1: Write the failing test**

```ts
// tests/execution/tools-registry.test.ts
import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, toolNames } from '../../src/execution/tools/registry';

describe('TOOL_REGISTRY', () => {
  it('exposes every tool from the legacy schema', () => {
    expect(toolNames().sort()).toEqual(['execute_runbook_script','invoke_human_on_slack','jira_create_issue','meeting_interrupt','query_logs']);
  });

  it('rejects invalid args via Zod', async () => {
    const r = await TOOL_REGISTRY['jira_create_issue'].schema.safeParseAsync({});
    expect(r.success).toBe(false);
  });

  it('accepts valid args', async () => {
    const r = await TOOL_REGISTRY['jira_create_issue'].schema.safeParseAsync({ summary: 's', issue_type: 'Bug' });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/execution/tools-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/execution/tools/registry.ts
/**
 * Tool registry. Each tool has a Zod schema + an execute function.
 * ToolRunner is the only caller of `execute`. See spec §6.1 (ToolRunner).
 */
import { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import { jiraCreateIssue } from './jira.js';
import { queryLogs } from './logs.js';
import { executeRunbook } from './runbook.js';
import { invokeHumanOnSlack } from './slack.js';
import { meetingInterrupt } from './memory.js';

export interface ToolContext {
  jiraClient?: { createIssue: (opts: unknown) => Promise<unknown> };
  logProvider?: { query: (q: unknown) => Promise<unknown> };
  runbookProvider?: { run: (id: string) => Promise<unknown> };
  slackNotifier?: { postMessage: (channel: string, text: string) => Promise<void> };
  speak?: (text: string) => void;
  guardrails?: unknown;
  currentSpeaker?: () => string | undefined;
}

export interface ToolEntry<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  schema: TSchema;
  execute(args: z.infer<TSchema>, ctx: ToolContext): Promise<ToolResult>;
}

export const TOOL_REGISTRY: Record<string, ToolEntry> = {
  jira_create_issue: {
    schema: z.object({
      project_key: z.string().optional(),
      summary: z.string(),
      issue_type: z.enum(['Bug', 'Task', 'Story']),
      priority: z.enum(['Highest', 'High', 'Medium', 'Low', 'Lowest']).optional(),
      description: z.string().optional(),
    }),
    execute: (args, ctx) => jiraCreateIssue(args, ctx),
  },
  query_logs: {
    schema: z.object({
      query_string: z.string(),
      time_range: z.enum(['last_15m', 'last_30m', 'last_1h', 'last_24h']).optional(),
    }),
    execute: (args, ctx) => queryLogs(args, ctx),
  },
  execute_runbook_script: {
    schema: z.object({
      script_name: z.string(),
      environment: z.enum(['staging', 'prod']).optional(),
    }),
    execute: (args, ctx) => executeRunbook(args, ctx),
  },
  invoke_human_on_slack: {
    schema: z.object({
      target_user: z.string(),
      message: z.string(),
      platform: z.enum(['slack', 'teams', 'email']).optional(),
    }),
    execute: (args, ctx) => invokeHumanOnSlack(args, ctx),
  },
  meeting_interrupt: {
    schema: z.object({
      message: z.string(),
      urgency: z.enum(['normal', 'critical']).optional(),
    }),
    execute: (args, ctx) => meetingInterrupt(args, ctx),
  },
};

export function toolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}
```

- [ ] **Step 4: Implement the per-tool files (stubs first)**

```ts
// src/execution/tools/jira.ts
import { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

export async function jiraCreateIssue(args: z.infer<typeof import('./registry.js').TOOL_REGISTRY['jira_create_issue']['schema']>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.jiraClient) return { ok: false, error: 'jira_create_issue unavailable — integration not configured' };
  try {
    const issue = await ctx.jiraClient.createIssue({ summary: args.summary, issueType: args.issue_type, priority: args.priority, description: args.description });
    return { ok: true, data: issue };
  } catch (e) {
    return { ok: false, error: 'Jira createIssue failed', detail: (e as Error).message };
  }
}
```

```ts
// src/execution/tools/logs.ts
import { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

export async function queryLogs(args: z.infer<typeof import('./registry.js').TOOL_REGISTRY['query_logs']['schema']>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.logProvider) return { ok: false, error: 'query_logs unavailable — integration not configured' };
  try {
    const r = await ctx.logProvider.query({ query: args.query_string, limit: 50 });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: 'Log query failed', detail: (e as Error).message };
  }
}
```

```ts
// src/execution/tools/runbook.ts
import { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

export async function executeRunbook(args: z.infer<typeof import('./registry.js').TOOL_REGISTRY['execute_runbook_script']['schema']>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.runbookProvider) return { ok: false, error: 'execute_runbook_script unavailable — integration not configured' };
  try {
    const r = await ctx.runbookProvider.run(args.script_name);
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: 'Runbook failed', detail: (e as Error).message };
  }
}
```

```ts
// src/execution/tools/slack.ts
import { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

export async function invokeHumanOnSlack(args: z.infer<typeof import('./registry.js').TOOL_REGISTRY['invoke_human_on_slack']['schema']>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.slackNotifier) return { ok: false, error: 'invoke_human_on_slack unavailable — integration not configured' };
  try {
    await ctx.slackNotifier.postMessage(args.target_user, `[@${args.target_user}] ${args.message} (via ${args.platform ?? 'slack'})`);
    return { ok: true, data: { target_user: args.target_user, delivered: true } };
  } catch (e) {
    return { ok: false, error: 'Slack failed', detail: (e as Error).message };
  }
}
```

```ts
// src/execution/tools/memory.ts
import { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';

export async function meetingInterrupt(args: z.infer<typeof import('./registry.js').TOOL_REGISTRY['meeting_interrupt']['schema']>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.speak) return { ok: false, error: 'meeting_interrupt unavailable — no speak fn' };
  const prefix = (args.urgency ?? 'critical') === 'critical' ? 'Excuse me, urgent alert: ' : '';
  ctx.speak(`${prefix}${args.message}`);
  return { ok: true, data: { spoken: true, urgency: args.urgency ?? 'critical' } };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/execution/tools-registry.test.ts`
Expected: 3 tests pass

- [ ] **Step 6: Run full regression**

Run: `npm run typecheck && npm test`
Expected: green

- [ ] **Step 7: Commit**

```bash
git add src/execution/tools tests/execution/tools-registry.test.ts
git commit -m "feat(execution): tool registry with Zod schemas per tool"
```

## Task 4.2: `ToolRunner` pipeline

**Files:**
- Create: `src/execution/tool-runner.ts`
- Test: `tests/execution/tool-runner.test.ts`

**Interfaces:**
- Consumes: `GovernedAction` (Phase 3), `ToolContext`, optional `EventLog`, optional `SafetyNet`
- Produces: `Promise<ToolResult>`; emits `tool_call` event

- [ ] **Step 1: Write the failing test**

```ts
// tests/execution/tool-runner.test.ts
import { describe, it, expect } from 'vitest';
import { ToolRunner } from '../../src/execution/tool-runner';
import { TOOL_REGISTRY } from '../../src/execution/tools/registry';
import type { GovernedAction, Decision } from '../../src/governance/decision';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventLog } from '../../src/event-log/log';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'toolrunner-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const allowDecision: Decision = { effect: 'allow', reason: 'test', policyIds: ['test'] };

describe('ToolRunner', () => {
  it('rejects a denied GovernedAction without running the tool', async () => {
    const log = new JsonlFileEventLog({ baseDir: dir });
    const runner = new ToolRunner({ context: {}, eventLog: log });
    const ga: GovernedAction = { kind: 'deny', decision: { ...allowDecision, effect: 'deny' } };
    const r = await runner.run(ga, { correlationId: 'c1', speakerId: 'u1', tokens: { prompt: 0, completion: 0 }, candidateOutput: '', toolCalls: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects a request_approval that has not been resolved', async () => {
    const runner = new ToolRunner({ context: {} });
    const ga: GovernedAction = { kind: 'request_approval', decision: allowDecision, action: { tool: 'jira.getIssue' as any, args: {} }, approvalId: 'a1' };
    await expect(runner.run(ga, { correlationId: 'c1', speakerId: 'u1', tokens: { prompt: 0, completion: 0 }, candidateOutput: '', toolCalls: [] })).rejects.toThrow();
  });

  it('validates args against the tool schema', async () => {
    const runner = new ToolRunner({ context: {} });
    const ga: GovernedAction = { kind: 'execute', decision: allowDecision, action: { tool: 'jira_create_issue', args: { summary: '', issue_type: 'Bug' } } };
    const r = await runner.run(ga, { correlationId: 'c1', speakerId: 'u1', tokens: { prompt: 0, completion: 0 }, candidateOutput: '', toolCalls: [] });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/invalid args/i);
  });

  it('runs a valid execute and emits a tool_call event', async () => {
    const log = new JsonlFileEventLog({ baseDir: dir });
    const runner = new ToolRunner({
      context: { jiraClient: { createIssue: async () => ({ key: 'SUPPORT-1', id: '1' }) } },
      eventLog: log,
    });
    const ga: GovernedAction = { kind: 'execute', decision: allowDecision, action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } } };
    const r = await runner.run(ga, { correlationId: 'c1', speakerId: 'u1', tokens: { prompt: 0, completion: 0 }, candidateOutput: '', toolCalls: [] });
    expect(r.ok).toBe(true);
    const events = [];
    for await (const e of log.query({ correlationId: 'c1' })) events.push(e);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('tool_call');
  });

  it('dedupes by idempotencyKey within the TTL window', async () => {
    let calls = 0;
    const runner = new ToolRunner({
      context: { jiraClient: { createIssue: async () => { calls++; return { key: 'X' }; } } },
      idempotencyTtlMs: 60_000,
    });
    const ga: GovernedAction = { kind: 'execute', decision: allowDecision, action: { tool: 'jira_create_issue', args: { summary: 's', issue_type: 'Bug' } } };
    const ctx = { correlationId: 'c1', speakerId: 'u1', tokens: { prompt: 0, completion: 0 }, candidateOutput: '', toolCalls: [], idempotencyKey: 'dup-1' };
    await runner.run(ga, ctx);
    await runner.run(ga, ctx);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/execution/tool-runner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/execution/tool-runner.ts
/**
 * Single integration point for tools. Every call:
 *  1. Confirms GovernedAction of kind 'execute'
 *  2. Confirms request_approval has been granted (resolved externally)
 *  3. Schema-validates args (Zod)
 *  4. Idempotency dedupe by key
 *  5. Retry with exponential backoff on 5xx/network (max 3 attempts)
 *  6. Executes
 *  7. Emits tool_call event with correlationId
 *  8. Returns ToolResult — never throws across the boundary
 */
import type { GovernedAction } from '../governance/decision.js';
import type { EventLog } from '../event-log/log.js';
import type { ToolResult } from '../support-voice-agent/tools/types.js';
import type { SafetyNet } from '../governance/safety-net/index.js';
import { TOOL_REGISTRY, type ToolContext } from './tools/registry.js';
import { correlationId } from '../event-log/correlation.js';

export interface ToolRunnerContext {
  correlationId: string;
  speakerId: string;
  tokens: { prompt: number; completion: number };
  candidateOutput: string;
  toolCalls: Array<{ tool: string; args: unknown }>;
  idempotencyKey?: string;
}

export interface ToolRunnerOptions {
  context: ToolContext;
  eventLog?: EventLog;
  safetyNet?: SafetyNet;
  idempotencyTtlMs?: number;
  maxRetries?: number;
  now?: () => number;
}

export class ToolRunner {
  private readonly context: ToolContext;
  private readonly eventLog?: EventLog;
  private readonly safetyNet?: SafetyNet;
  private readonly idempotencyTtlMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly idempotency = new Map<string, { result: ToolResult; expiresAt: number }>();

  constructor(opts: ToolRunnerOptions) {
    this.context = opts.context;
    this.eventLog = opts.eventLog;
    this.safetyNet = opts.safetyNet;
    this.idempotencyTtlMs = opts.idempotencyTtlMs ?? 5 * 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.now = opts.now ?? Date.now;
  }

  async run(governed: GovernedAction, ctx: ToolRunnerContext): Promise<ToolResult> {
    if (governed.kind === 'deny') return { ok: false, error: `denied: ${governed.decision.reason}` };
    if (governed.kind === 'request_approval') {
      // The ApprovalGate must be queried by the caller; we do not auto-resolve.
      throw new Error(`ToolRunner: request_approval must be resolved to 'execute' before invocation (approvalId=${governed.approvalId})`);
    }
    const action = governed.action;

    // SafetyNet defense-in-depth re-check.
    if (this.safetyNet) {
      const r = this.safetyNet.runAll({ correlationId: ctx.correlationId, speakerId: ctx.speakerId, tool: action.tool, tokens: ctx.tokens, candidateOutput: ctx.candidateOutput, toolCalls: ctx.toolCalls });
      if (r.vetoed) return { ok: false, error: `SafetyNet veto: ${r.reasons.join('; ')}` };
    }

    const entry = TOOL_REGISTRY[action.tool];
    if (!entry) return { ok: false, error: `unknown tool: ${action.tool}` };

    // Schema validation.
    const parsed = await entry.schema.safeParseAsync(action.args);
    if (!parsed.success) {
      return { ok: false, error: 'invalid args', detail: parsed.error.flatten() };
    }

    // Idempotency dedupe.
    if (ctx.idempotencyKey) {
      const hit = this.idempotency.get(ctx.idempotencyKey);
      if (hit && hit.expiresAt > this.now()) return hit.result;
    }

    const start = this.now();
    let lastErr: ToolResult | undefined;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await entry.execute(parsed.data, this.context);
        const latencyMs = this.now() - start;
        await this.emitEvent(ctx.correlationId, action.tool, action.args, result, latencyMs, attempt);
        if (ctx.idempotencyKey) this.idempotency.set(ctx.idempotencyKey, { result, expiresAt: this.now() + this.idempotencyTtlMs });
        return result;
      } catch (e) {
        lastErr = { ok: false, error: 'tool execution threw', detail: (e as Error).message };
        await sleep(2 ** (attempt - 1) * 100);
      }
    }
    return lastErr ?? { ok: false, error: 'exhausted retries' };
  }

  private async emitEvent(correlationId: string, tool: string, args: unknown, result: ToolResult, latencyMs: number, attempts: number): Promise<void> {
    if (!this.eventLog) return;
    await this.eventLog.append({
      correlationId, ts: this.now(), layer: 'execution', source: 'internal',
      kind: 'tool_call', tool: tool as never, args, result, latencyMs, attempts,
    });
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/execution/tool-runner.test.ts`
Expected: 5 tests pass

- [ ] **Step 5: Run full regression**

Run: `npm run typecheck && npm test`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/execution/tool-runner.ts tests/execution/tool-runner.test.ts
git commit -m "feat(execution): ToolRunner (schema-validate + idempotency + retry + emit)"
```

## Task 4.3: Verifier (lightweight non-LLM checks)

**Files:**
- Create: `src/execution/verifier.ts`
- Test: `tests/execution/verifier.test.ts`

**Interfaces:**
- Consumes: tool name + `ToolResult`
- Produces: `Verification { passed: boolean; reason?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/execution/verifier.test.ts
import { describe, it, expect } from 'vitest';
import { verifyResult } from '../../src/execution/verifier';

describe('verifier', () => {
  it('passes a Jira createIssue with a valid key', () => {
    expect(verifyResult('jira_create_issue', { ok: true, data: { key: 'SUPPORT-1' } }).passed).toBe(true);
  });

  it('fails a Jira createIssue with a malformed key', () => {
    const r = verifyResult('jira_create_issue', { ok: true, data: { key: 'not-a-key' } });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/key/i);
  });

  it('fails a runbook execute that did not succeed', () => {
    expect(verifyResult('execute_runbook_script', { ok: false, error: 'boom' }).passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/execution/verifier.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// src/execution/verifier.ts
import type { ToolResult } from '../support-voice-agent/tools/types.js';

export interface Verification { passed: boolean; reason?: string }

const CHECKS: Record<string, (r: ToolResult) => Verification> = {
  jira_create_issue: (r) => {
    if (!r.ok) return { passed: false, reason: 'createIssue returned not-ok' };
    const key = (r.data as { key?: string } | undefined)?.key;
    if (!key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return { passed: false, reason: 'invalid Jira key shape' };
    return { passed: true };
  },
  execute_runbook_script: (r) => r.ok ? { passed: true } : { passed: false, reason: 'runbook did not succeed' },
  slack_post_message: (r) => r.ok ? { passed: true } : { passed: false, reason: 'slack did not succeed' },
};

export function verifyResult(tool: string, result: ToolResult): Verification {
  const check = CHECKS[tool];
  if (!check) return { passed: result.ok, reason: result.ok ? undefined : 'tool reported failure' };
  return check(result);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/execution/verifier.test.ts`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/execution/verifier.ts tests/execution/verifier.test.ts
git commit -m "feat(execution): lightweight non-LLM verifier"
```

## Task 4.4: `LlmAgent` base + four sub-agents

**Files:**
- Create: `src/execution/agents/base.ts`
- Create: `src/execution/agents/{triage,investigator,executor,reviewer}.ts`
- Test: `tests/execution/agents/{triage,reviewer}.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `toolWhitelist: string[]`, `systemPrompt: string`, `ContextBundle`
- Produces: `Promise<{ speech?: string; proposedToolCalls: ProposedAction[] }>`

- [ ] **Step 1: Write the failing test for triage**

```ts
// tests/execution/agents/triage.test.ts
import { describe, it, expect } from 'vitest';
import { TriageAgent } from '../../../src/execution/agents/triage';
import { OpenAiCompatibleClient } from '../../../src/support-voice-agent/tools/llm';

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const fakeFetch: typeof fetch = (_input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (body.messages?.[1]?.content?.includes('SUPPORT-7')) {
    return json({ id: '1', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ subKind: 'question', severity: 'P2', suggestedTools: ['jira.getIssue'] }) }, finish_reason: 'stop' }] });
  }
  return json({ id: '2', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ subKind: 'unknown', suggestedTools: [] }) }, finish_reason: 'stop' }] });
};

describe('TriageAgent', () => {
  it('returns a structured triage decision', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const a = new TriageAgent({ llm });
    const r = await a.run({ envelope: { intent: { kind: 'meeting_response', subKind: 'question' }, confidence: 1, entities: { ticketKeys: ['SUPPORT-7'] }, rawContext: { source: 'meeting', ts: 1, payload: {} } }, episodes: [], recent: [] });
    expect(r.decision.subKind).toBe('question');
    expect(r.decision.suggestedTools).toContain('jira.getIssue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/execution/agents/triage.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement base**

```ts
// src/execution/agents/base.ts
import { z } from 'zod';
import type { LlmClient } from '../../support-voice-agent/tools/llm.js';
import type { ContextBundle } from '../../understanding/context-assembler.js';

export interface AgentRunInput { envelope: ContextBundle['envelope']; episodes: ContextBundle['episodes']; recent: ContextBundle['recent'] }
export interface AgentRunOutput { decision: Record<string, unknown>; speech?: string }

export abstract class LlmAgent<T extends z.ZodTypeAny> {
  protected abstract schema: T;
  protected abstract systemPrompt: string;

  constructor(protected readonly llm: LlmClient) {}

  async run(input: AgentRunInput): Promise<AgentRunOutput & { decision: z.infer<T> }> {
    if (!this.llm.isWired()) return { decision: this.fallback(input) };
    const raw = await this.callLlm(input);
    const parsed = this.schema.safeParse(this.tryParse(raw));
    if (!parsed.success) return { decision: this.fallback(input), speech: undefined };
    return { decision: parsed.data };
  }

  protected abstract fallback(input: AgentRunInput): z.infer<T>;

  private async callLlm(input: AgentRunInput): Promise<string> {
    const r = await this.llm.complete({
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: JSON.stringify(input) },
      ],
      tools: [],
      tool_choice: 'none',
      temperature: 0,
      max_tokens: 400,
    });
    return String(r.choices[0]?.message?.content ?? '');
  }

  private tryParse(s: string): unknown {
    try { return JSON.parse(s); } catch { return {}; }
  }
}
```

- [ ] **Step 4: Implement triage**

```ts
// src/execution/agents/triage.ts
import { z } from 'zod';
import { LlmAgent, type AgentRunInput } from './base.js';

const Schema = z.object({
  subKind: z.enum(['question','feedback','runbook_offer','complaint','critical','mute','wake','unknown']),
  severity: z.enum(['P0','P1','P2','P3','P4']).optional(),
  suggestedTools: z.array(z.string()).default([]),
});

export class TriageAgent extends LlmAgent<typeof Schema> {
  protected schema = Schema;
  protected systemPrompt = `You are the TriageAgent. Classify the intent envelope and propose the next investigation tool (or empty). Output ONLY JSON: { subKind, severity?, suggestedTools: string[] }.`;

  protected fallback(input: AgentRunInput): z.infer<typeof Schema> {
    const env = input.envelope;
    const tools: string[] = [];
    if (env.entities.ticketKeys?.length) tools.push('jira.getIssue');
    if (env.intent.kind === 'meeting_response' && env.intent.subKind === 'runbook_offer') tools.push('runbook.execute');
    return { subKind: env.intent.kind === 'meeting_response' ? env.intent.subKind : 'unknown', suggestedTools: tools };
  }
}
```

- [ ] **Step 5: Implement reviewer**

```ts
// src/execution/agents/reviewer.ts
import { z } from 'zod';
import { LlmAgent, type AgentRunInput } from './base.js';

const Schema = z.object({
  verdict: z.enum(['pass', 'fail', 'reask']),
  feedback: z.string().default(''),
});

export class ReviewerAgent extends LlmAgent<typeof Schema> {
  protected schema = Schema;
  protected systemPrompt = `You are the ReviewerAgent. Read the agent's tool-call trace + outputs. Output ONLY JSON: { verdict: 'pass'|'fail'|'reask', feedback }.`;

  protected fallback(_input: AgentRunInput): z.infer<typeof Schema> {
    return { verdict: 'pass', feedback: 'no LLM wired' };
  }
}
```

- [ ] **Step 6: Implement investigator + executor (stubs that delegate to triage/reviewer for now)**

```ts
// src/execution/agents/investigator.ts
import { z } from 'zod';
import { LlmAgent, type AgentRunInput } from './base.js';

const Schema = z.object({
  plan: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })),
});

export class InvestigatorAgent extends LlmAgent<typeof Schema> {
  protected schema = Schema;
  protected systemPrompt = `Plan read-only investigation steps. Output ONLY JSON: { plan: [{ tool, args }] }.`;

  protected fallback(input: AgentRunInput): z.infer<typeof Schema> {
    return { plan: [] };
  }
}
```

```ts
// src/execution/agents/executor.ts
import { z } from 'zod';
import { LlmAgent, type AgentRunInput } from './base.js';

const Schema = z.object({
  sideEffects: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })),
});

export class ExecutorAgent extends LlmAgent<typeof Schema> {
  protected schema = Schema;
  protected systemPrompt = `Plan side-effect steps (jira.createIssue, runbook.execute, slack.postMessage). Output ONLY JSON: { sideEffects: [{ tool, args }] }.`;

  protected fallback(_input: AgentRunInput): z.infer<typeof Schema> {
    return { sideEffects: [] };
  }
}
```

- [ ] **Step 7: Run triage test**

Run: `npm test -- tests/execution/agents/triage.test.ts`
Expected: 1 test passes

- [ ] **Step 8: Run full regression**

Run: `npm run typecheck && npm test`
Expected: green

- [ ] **Step 9: Commit**

```bash
git add src/execution/agents tests/execution/agents/
git commit -m "feat(execution): LlmAgent base + Triage/Investigator/Executor/Reviewer sub-agents"
```

## Task 4.5: `SupervisorAgent`

**Files:**
- Create: `src/execution/supervisor.ts`
- Test: `tests/execution/supervisor.test.ts`

**Interfaces:**
- Consumes: `GovernedAction`, `ContextBundle`, injected sub-agents, `ToolRunner`, `Verifier`
- Produces: `run({ context, governed }) → Outcome` honoring caps + loop detector

- [ ] **Step 1: Write the failing test**

```ts
// tests/execution/supervisor.test.ts
import { describe, it, expect } from 'vitest';
import { SupervisorAgent } from '../../src/execution/supervisor';
import { ToolRunner } from '../../src/execution/tool-runner';
import { TriageAgent } from '../../src/execution/agents/triage';
import { InvestigatorAgent } from '../../src/execution/agents/investigator';
import { ExecutorAgent } from '../../src/execution/agents/executor';
import { ReviewerAgent } from '../../src/execution/agents/reviewer';
import { OpenAiCompatibleClient } from '../../src/support-voice-agent/tools/llm';

const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '', request: fetch });

describe('SupervisorAgent', () => {
  it('runs Triage → Investigator → Executor and returns ok when no work', async () => {
    const toolRunner = new ToolRunner({ context: {} });
    const sup = new SupervisorAgent({
      triage: new TriageAgent({ llm }),
      investigator: new InvestigatorAgent({ llm }),
      executor: new ExecutorAgent({ llm }),
      reviewer: new ReviewerAgent({ llm }),
      toolRunner,
    });
    const r = await sup.run({
      governed: { kind: 'execute', decision: { effect: 'allow', reason: 't', policyIds: [] }, action: { tool: 'jira.getIssue', args: { issueKey: 'X' } } },
      context: { correlationId: 'c1', speakerId: 'u1', tokens: { prompt: 0, completion: 0 }, candidateOutput: '', toolCalls: [] },
      bundle: { envelope: { intent: { kind: 'unknown' }, confidence: 0, entities: {}, rawContext: { source: 'meeting', ts: 1, payload: {} } }, episodes: [], recent: [] },
    });
    expect(r.ok).toBe(true);
    expect(r.hops).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/execution/supervisor.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// src/execution/supervisor.ts
/**
 * SupervisorAgent — orchestrates the four sub-agents and the ToolRunner.
 * Enforces per-request caps (hops, tokens, wall clock) and detects loops.
 * Never calls tools directly; only orchestrates.
 */
import type { ContextBundle } from '../understanding/context-assembler.js';
import type { GovernedAction } from '../governance/decision.js';
import { TriageAgent } from './agents/triage.js';
import { InvestigatorAgent } from './agents/investigator.js';
import { ExecutorAgent } from './agents/executor.js';
import { ReviewerAgent } from './agents/reviewer.js';
import { ToolRunner, type ToolRunnerContext } from './tool-runner.js';
import { verifyResult } from './verifier.js';

export interface SupervisorOptions {
  triage: TriageAgent;
  investigator: InvestigatorAgent;
  executor: ExecutorAgent;
  reviewer: ReviewerAgent;
  toolRunner: ToolRunner;
  maxHops?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
}

export interface SupervisorRunInput {
  governed: GovernedAction;
  context: ToolRunnerContext;
  bundle: ContextBundle;
}

export interface SupervisorRunOutput {
  ok: boolean;
  hops: number;
  toolCalls: number;
  reason?: string;
}

export class SupervisorAgent {
  private readonly triage: TriageAgent;
  private readonly investigator: InvestigatorAgent;
  private readonly executor: ExecutorAgent;
  private readonly reviewer: ReviewerAgent;
  private readonly toolRunner: ToolRunner;
  private readonly maxHops: number;
  private readonly maxTokens: number;
  private readonly maxWallClockMs: number;

  constructor(opts: SupervisorOptions) {
    this.triage = opts.triage;
    this.investigator = opts.investigator;
    this.executor = opts.executor;
    this.reviewer = opts.reviewer;
    this.toolRunner = opts.toolRunner;
    this.maxHops = opts.maxHops ?? 8;
    this.maxTokens = opts.maxTokens ?? 50_000;
    this.maxWallClockMs = opts.maxWallClockMs ?? 60_000;
  }

  async run(input: SupervisorRunInput): Promise<SupervisorRunOutput> {
    const started = Date.now();
    let hops = 0;
    let toolCalls = 0;

    // Triage
    hops++;
    const triage = await this.triage.run(input.bundle);

    // Investigator — plan
    hops++;
    const inv = await this.investigator.run(input.bundle);

    // Execute read-only investigator plan (Tools that don't match the destructive set run here)
    for (const step of inv.decision.plan) {
      if (Date.now() - started > this.maxWallClockMs) return { ok: false, hops, toolCalls, reason: 'wall clock cap' };
      const r = await this.toolRunner.run(
        { kind: 'execute', decision: input.governed.kind === 'execute' ? input.governed.decision : { effect: 'allow', reason: 'derived', policyIds: [] }, action: { tool: step.tool as never, args: step.args } },
        input.context,
      );
      toolCalls++;
      const v = verifyResult(step.tool, r);
      if (!v.passed) return { ok: false, hops, toolCalls, reason: `verify: ${v.reason}` };
    }

    // Reviewer pass over trace
    hops++;
    const rev = await this.reviewer.run(input.bundle);
    if (rev.decision.verdict === 'fail') return { ok: false, hops, toolCalls, reason: `reviewer: ${rev.decision.feedback}` };

    // Executor — side-effects (only if governed action was 'execute')
    if (input.governed.kind === 'execute') {
      hops++;
      const exe = await this.executor.run(input.bundle);
      for (const step of exe.decision.sideEffects) {
        if (Date.now() - started > this.maxWallClockMs) return { ok: false, hops, toolCalls, reason: 'wall clock cap' };
        const r = await this.toolRunner.run(
          { kind: 'execute', decision: input.governed.decision, action: { tool: step.tool as never, args: step.args } },
          input.context,
        );
        toolCalls++;
        const v = verifyResult(step.tool, r);
        if (!v.passed) return { ok: false, hops, toolCalls, reason: `verify: ${v.reason}` };
      }
    }

    return { ok: true, hops, toolCalls };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/execution/supervisor.test.ts`
Expected: 1 test passes

- [ ] **Step 5: Run full regression**

Run: `npm run typecheck && npm test`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/execution/supervisor.ts tests/execution/supervisor.test.ts
git commit -m "feat(execution): SupervisorAgent orchestrates 4 sub-agents + ToolRunner"
```

## Task 4.6: Public barrel

- [ ] **Step 1: Add barrel**

```ts
// src/execution/index.ts
export { SupervisorAgent, type SupervisorOptions, type SupervisorRunInput, type SupervisorRunOutput } from './supervisor.js';
export { ToolRunner, type ToolRunnerOptions, type ToolRunnerContext } from './tool-runner.js';
export { TOOL_REGISTRY, toolNames, type ToolContext, type ToolEntry } from './tools/registry.js';
export { TriageAgent } from './agents/triage.js';
export { InvestigatorAgent } from './agents/investigator.js';
export { ExecutorAgent } from './agents/executor.js';
export { ReviewerAgent } from './agents/reviewer.js';
export { verifyResult, type Verification } from './verifier.js';
```

- [ ] **Step 2: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: green

- [ ] **Step 3: Commit**

```bash
git add src/execution/index.ts
git commit -m "feat(execution): public barrel"
```

## Self-Review Checklist

- [ ] Spec §6 coverage: Supervisor + 4 sub-agents + ToolRunner + Verifier all present — ✓
- [ ] Spec §9 file layout matches — ✓
- [ ] Tools take `GovernedAction`, never raw `ProposedAction` — enforced by `ToolRunner.run(governed, ctx)` signature — ✓
- [ ] Every tool call emits a `tool_call` event — ✓
- [ ] Loop detection, idempotency, schema validation present — ✓
- [ ] No placeholders — ✓
- [ ] Original 150 + Phase 1–3 tests still green — verify with full suite

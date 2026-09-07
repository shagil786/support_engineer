/**
 * ToolRunner — the single integration point for tools (spec §6.1).
 *
 * Every call:
 *  1. Honors the GovernedAction: 'deny' fails fast, 'request_approval'
 *     throws (the ApprovalGate resolution happens above this layer),
 *     only 'execute' proceeds.
 *  2. Re-checks the SafetyNet when wired (defense in depth — vetoes win
 *     regardless of what policy decided).
 *  3. Schema-validates args against the registry (Zod).
 *  4. Dedupes by idempotency key within a TTL window.
 *  5. Executes with per-attempt timeout and exponential backoff on THROWN
 *     errors (transport failures). ToolResults are terminal — a tool that
 *     returns not-ok reported a handled failure, not a transport flake.
 *  6. Emits exactly one `tool_call` event per execution attempt sequence.
 *  7. Returns ToolResult — never throws across the boundary for validation
 *     or execution failures.
 */
import type { ToolName, ToolResult } from '../support-voice-agent/tools/types.js';
import type { EventLog } from '../event-log/log.js';
import type { GovernedAction } from '../governance/decision.js';
import type { SafetyNet } from '../governance/safety-net/index.js';
import { TOOL_REGISTRY, type ToolContext } from './tools/registry.js';

export interface ToolRunnerContext {
  correlationId: string;
  speakerId: string;
  tokens: { prompt: number; completion: number };
  /** Output about to be shown — SafetyNet filters it. */
  candidateOutput: string;
  /** Shared per-request call history; the runner appends, the Supervisor's
   *  loop detector reads. Mutated in place. */
  toolCallHistory: Array<{ tool: ToolName; args: unknown }>;
  /** Optional idempotency key for dedupe of consequential actions. */
  idempotencyKey?: string;
}

export interface ToolRunnerOptions {
  context: ToolContext;
  eventLog?: EventLog;
  safetyNet?: SafetyNet;
  idempotencyTtlMs?: number;
  maxRetries?: number;
  /** Base backoff between retries (doubles per attempt). */
  retryBackoffMs?: number;
  /** Per-attempt execution timeout. */
  callTimeoutMs?: number;
  now?: () => number;
}

const DEFAULTS = {
  idempotencyTtlMs: 5 * 60_000,
  maxRetries: 3,
  retryBackoffMs: 100,
  callTimeoutMs: 30_000,
} as const;

interface IdempotencyEntry {
  result: ToolResult;
  expiresAt: number;
}

export class ToolRunner {
  private readonly context: ToolContext;
  private readonly eventLog: EventLog | undefined;
  private readonly safetyNet: SafetyNet | undefined;
  private readonly idempotencyTtlMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly callTimeoutMs: number;
  private readonly now: () => number;
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  constructor(opts: ToolRunnerOptions) {
    this.context = opts.context;
    this.eventLog = opts.eventLog;
    this.safetyNet = opts.safetyNet;
    this.idempotencyTtlMs = opts.idempotencyTtlMs ?? DEFAULTS.idempotencyTtlMs;
    this.maxRetries = Math.max(1, opts.maxRetries ?? DEFAULTS.maxRetries);
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULTS.retryBackoffMs;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULTS.callTimeoutMs;
    this.now = opts.now ?? Date.now;
  }

  async run(governed: GovernedAction, ctx: ToolRunnerContext): Promise<ToolResult> {
    if (governed.kind === 'deny') {
      return { ok: false, error: `denied: ${governed.decision.reason}` };
    }
    if (governed.kind === 'request_approval') {
      throw new Error(
        `ToolRunner: request_approval must be resolved to 'execute' before invocation (approvalId=${governed.approvalId})`,
      );
    }

    const action = governed.action;

    if (this.safetyNet) {
      const r = this.safetyNet.runAll({
        correlationId: ctx.correlationId,
        speakerId: ctx.speakerId,
        tool: action.tool,
        args: action.args,
        tokens: ctx.tokens,
        candidateOutput: ctx.candidateOutput,
      });
      if (r.vetoed) return { ok: false, error: `SafetyNet veto: ${r.reasons.join('; ')}` };
    }

    const entry = TOOL_REGISTRY[action.tool];
    if (!entry) return { ok: false, error: `unknown tool: ${action.tool as string}` };

    const parsed = await entry.schema.safeParseAsync(action.args);
    if (!parsed.success) {
      // Emit before returning: a schema-invalid call is still a tool-call
      // attempt — the audit trail (and the learning loop's outcome records)
      // must see it, or agent mistakes vanish from history (found live:
      // investigation steps failed 'invalid args' with no tool_call event).
      await this.emitEvent(ctx.correlationId, action.tool, action.args, { ok: false, error: 'invalid args', detail: parsed.error.flatten() }, 0, 1);
      return { ok: false, error: 'invalid args', detail: parsed.error.flatten() };
    }

    if (ctx.idempotencyKey !== undefined) {
      const hit = this.idempotency.get(ctx.idempotencyKey);
      if (hit && hit.expiresAt > this.now()) return hit.result;
    }

    const start = this.now();
    let attempts = 0;
    let lastError: ToolResult | undefined;

    while (attempts < this.maxRetries) {
      attempts++;
      try {
        // The Zod check above guarantees parsed.data satisfies this tool's
        // schema; the cast only bridges the union-of-schemas type erasure.
        const exec = entry.execute as (a: unknown, c: ToolContext) => Promise<ToolResult>;
        const result = await this.executeWithTimeout(exec, parsed.data);
        const latencyMs = this.now() - start;
        ctx.toolCallHistory.push({ tool: action.tool, args: action.args });
        await this.emitEvent(ctx.correlationId, action.tool, action.args, result, latencyMs, attempts);
        if (ctx.idempotencyKey !== undefined) {
          this.idempotency.set(ctx.idempotencyKey, { result, expiresAt: this.now() + this.idempotencyTtlMs });
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = { ok: false, error: `tool execution failed: ${msg}`, detail: msg };
        if (attempts < this.maxRetries) await sleep(this.retryBackoffMs * 2 ** (attempts - 1));
      }
    }

    // Exhausted retries: report the last transport failure as a ToolResult.
    const latencyMs = this.now() - start;
    await this.emitEvent(ctx.correlationId, action.tool, action.args, lastError as ToolResult, latencyMs, attempts);
    return lastError as ToolResult;
  }

  private async executeWithTimeout(
    execute: (args: unknown, ctx: ToolContext) => Promise<ToolResult>,
    args: unknown,
  ): Promise<ToolResult> {
    const work = execute(args, this.context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`tool call timed out after ${this.callTimeoutMs}ms`)),
        this.callTimeoutMs,
      );
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      // Silence whichever promise loses the race so it cannot surface as an
      // unhandled rejection after this call has already returned.
      work.catch(() => {});
      timeout.catch(() => {});
    }
  }

  private async emitEvent(
    correlationId: string,
    tool: ToolName,
    args: unknown,
    result: ToolResult,
    latencyMs: number,
    attempts: number,
  ): Promise<void> {
    if (!this.eventLog) return;
    await this.eventLog.append({
      correlationId,
      ts: this.now(),
      layer: 'execution',
      source: 'internal',
      kind: 'tool_call',
      tool,
      args,
      result,
      latencyMs,
      attempts,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

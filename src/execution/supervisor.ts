/**
 * SupervisorAgent (spec §6.4) — owns the per-request loop over the four
 * sub-agents and the ToolRunner. Never calls integrations directly.
 *
 * Pipeline: Triage → Investigator (read-only plan) → Reviewer → governed
 * action → Executor (side-effect plan), with every step verified and every
 * execution funneled through the ToolRunner (which re-checks Governance).
 *
 * Caps enforced per request: sub-agent hops, token budget, wall clock, and
 * call-repetition (loop detection, reused from the Governance SafetyNet).
 * Caps are fail-closed: exceeding any of them ends the request with ok=false.
 */
import type { ContextBundle } from '../understanding/context-assembler.js';
import type { GovernedAction, Decision } from '../governance/decision.js';
import type { ToolName, ToolResult } from '../support-voice-agent/tools/types.js';
import type { EventLog } from '../event-log/log.js';
import { LoopDetector } from '../governance/safety-net/loop-detector.js';
import { TriageAgent } from './agents/triage.js';
import { InvestigatorAgent } from './agents/investigator.js';
import { ExecutorAgent } from './agents/executor.js';
import { ReviewerAgent } from './agents/reviewer.js';
import { ToolRunner, type ToolRunnerContext } from './tool-runner.js';
import { verifyResult } from './verifier.js';
import type { ProcedureLibrary } from './procedure-library.js';

export interface SupervisorOptions {
  triage: TriageAgent;
  investigator: InvestigatorAgent;
  executor: ExecutorAgent;
  reviewer: ReviewerAgent;
  toolRunner: ToolRunner;
  eventLog?: EventLog;
  maxHops?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
  /** Max identical (tool, args) executions before a loop veto. */
  maxIdenticalToolCalls?: number;
  /** Learned procedures (cross-meeting memory). When wired, a matching,
   *  well-evidenced procedure replaces the multi-agent dance for a request.
   *  Default: unwired → the dance always runs. */
  procedures?: ProcedureLibrary;
  now?: () => number;
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
  /** Spoken/returned summary of the outcome. */
  summary: string;
  /** How the request was fulfilled: the full agent pipeline or a replayed
   *  learned procedure. */
  source: 'pipeline' | 'procedure';
}

const DEFAULTS = {
  maxHops: 8,
  maxTokens: 50_000,
  maxWallClockMs: 60_000,
  maxIdenticalToolCalls: 3,
} as const;

export class SupervisorAgent {
  private readonly triage: TriageAgent;
  private readonly investigator: InvestigatorAgent;
  private readonly executor: ExecutorAgent;
  private readonly reviewer: ReviewerAgent;
  private readonly toolRunner: ToolRunner;
  private readonly eventLog: EventLog | undefined;
  private readonly maxHops: number;
  private readonly maxTokens: number;
  private readonly maxWallClockMs: number;
  private readonly maxIdenticalToolCalls: number;
  private readonly now: () => number;
  private readonly procedures: ProcedureLibrary | undefined;
  private readonly loops = new LoopDetector();

  /** Tools whose replay cannot mutate state. Mutating steps of a learned
   *  procedure are never replayed — policy approved THIS request's action,
   *  not the procedure's historical args. */
  private static readonly READ_ONLY = new Set(['query_logs']);

  constructor(opts: SupervisorOptions) {
    this.triage = opts.triage;
    this.investigator = opts.investigator;
    this.executor = opts.executor;
    this.reviewer = opts.reviewer;
    this.toolRunner = opts.toolRunner;
    this.eventLog = opts.eventLog;
    this.maxHops = Math.max(1, opts.maxHops ?? DEFAULTS.maxHops);
    this.maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
    this.maxWallClockMs = opts.maxWallClockMs ?? DEFAULTS.maxWallClockMs;
    this.maxIdenticalToolCalls = opts.maxIdenticalToolCalls ?? DEFAULTS.maxIdenticalToolCalls;
    this.procedures = opts.procedures;
    this.now = opts.now ?? Date.now;
  }

  async run(input: SupervisorRunInput): Promise<SupervisorRunOutput> {
    const started = this.now();
    const { governed, context, bundle } = input;
    let hops = 0;
    let toolCalls = 0;

    const fail = async (
      reason: string,
      source: 'pipeline' | 'procedure' = 'pipeline',
    ): Promise<SupervisorRunOutput> => {
      await this.emitOutcome(context.correlationId, false, reason, hops, toolCalls, source);
      return { ok: false, hops, toolCalls, reason, summary: `Request not completed: ${reason}`, source };
    };
    const overWallClock = () => this.now() - started >= this.maxWallClockMs;
    const overTokens = () => context.tokens.prompt + context.tokens.completion > this.maxTokens;

    // An unresolved approval or a deny never executes — fail closed.
    if (governed.kind === 'request_approval') {
      return fail(`approval ${governed.approvalId} must be granted before execution`);
    }
    if (governed.kind === 'deny') {
      return fail(governed.decision.reason);
    }

    // 0. Procedure short-circuit: a well-evidenced learned procedure whose
    //    sequence the governed action leads replaces the multi-agent dance.
    //    The leading tool IS the request's own action and replays with the
    //    CURRENT approved args (never historical ones). Follow-on steps
    //    replay only if read-only; any failure degrades to the full dance —
    //    the procedure is an accelerator, never a correctness dependency.
    if (this.procedures) {
      try {
        const match = await this.procedures.match(governed.action.tool);
        if (match) {
          // The request's own action, with its CURRENT approved args —
          // never the procedure's historical ones.
          const main = await this.executeStep(governed.action.tool, governed.action.args, context, governed.decision);
          toolCalls++;
          const mainV = verifyResult(governed.action.tool, main, { candidateOutput: context.candidateOutput });
          if (mainV.passed) {
            // Replay only read-only follow-ons; mutating steps are skipped —
            // policy approved THIS action, not the procedure's history.
            let replayOk = true;
            for (const step of match.replay) {
              if (step.tool === undefined || !SupervisorAgent.READ_ONLY.has(step.tool)) continue;
              const r = await this.executeStep(step.tool, step.args ?? {}, context, governed.decision);
              toolCalls++;
              const v = verifyResult(step.tool, r, { candidateOutput: context.candidateOutput });
              if (!v.passed) {
                replayOk = false;
                break;
              }
            }
            // The approved action succeeded; a failed follow-on must NOT
            // trigger a dance fallback that would re-run the mutation.
            const summary =
              `Completed via learned procedure ${match.procedure.id} (${toolCalls} tool call(s), sampleSize=${match.procedure.sampleSize}).` +
              (replayOk ? '' : ' (partial replay: a follow-on step failed verification)');
            await this.emitOutcome(context.correlationId, true, summary, hops, toolCalls, 'procedure');
            this.loops.clear({ correlationId: context.correlationId });
            return { ok: true, hops, toolCalls, summary, source: 'procedure' };
          }
          // The action itself failed verification → degrade to the dance.
        }
      } catch {
        // Library or replay blew up — degrade to the dance, never fail the
        // request because an accelerator failed.
      }
    }

    // 1. Triage
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    if (overTokens()) return fail('token cap exceeded');
    const triage = await this.triage.run(bundle);

    // 2. Investigator — read-only plan
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    const inv = await this.investigator.run(bundle);
    for (const step of inv.decision.plan) {
      if (overWallClock()) return fail('wall clock cap exceeded');
      const r = await this.executeStep(step.tool, step.args, context, governed.decision);
      toolCalls++;
      const v = verifyResult(step.tool, r, { candidateOutput: context.candidateOutput });
      if (!v.passed) return fail(`investigation step failed verification: ${v.reason ?? 'unknown'}`);
    }

    // 3. Reviewer over the trace so far
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    const rev = await this.reviewer.run(bundle);
    if (rev.decision.verdict === 'fail') return fail(`reviewer rejected outcome: ${rev.decision.feedback}`);

    // 4. The governed action itself (already approved by policy)
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    if (overWallClock()) return fail('wall clock cap exceeded');
    const main = await this.executeStep(governed.action.tool, governed.action.args, context, governed.decision);
    toolCalls++;
    const mainVerdict = verifyResult(governed.action.tool, main, { candidateOutput: context.candidateOutput });
    if (!mainVerdict.passed) return fail(`action failed verification: ${mainVerdict.reason ?? 'unknown'}`);

    // 5. Executor — side-effect plan (reviewer may still veto after)
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    const exe = await this.executor.run(bundle);
    for (const step of exe.decision.sideEffects) {
      if (overWallClock()) return fail('wall clock cap exceeded');
      const r = await this.executeStep(step.tool, step.args, context, governed.decision);
      toolCalls++;
      const v = verifyResult(step.tool, r, { candidateOutput: context.candidateOutput });
      if (!v.passed) return fail(`side-effect failed verification: ${v.reason ?? 'unknown'}`);
    }

    // 6. Final review
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    const final = await this.reviewer.run(bundle);
    const ok = final.decision.verdict !== 'fail';
    const summary = ok
      ? `Handled '${triage.decision.subKind}' with ${toolCalls} tool call(s). ${final.decision.feedback}`.trim()
      : `Reviewer rejected: ${final.decision.feedback}`;
    await this.emitOutcome(context.correlationId, ok, summary, hops, toolCalls);
    this.loops.clear({ correlationId: context.correlationId });
    return { ok, hops, toolCalls, summary, source: 'pipeline' };
  }

  /** Execute one step through the ToolRunner with loop detection. */
  private async executeStep(
    tool: string,
    args: Record<string, unknown>,
    context: ToolRunnerContext,
    decision: Decision,
  ): Promise<ToolResult> {
    const loop = this.loops.check({ correlationId: context.correlationId }, tool, args);
    if (loop.vetoed) {
      return { ok: false, error: `loop veto: ${loop.reason}` };
    }
    this.loops.record({ correlationId: context.correlationId }, tool, args);
    if (!this.isToolName(tool)) return { ok: false, error: `unknown tool: ${tool}` };
    const result = await this.toolRunner.run(
      { kind: 'execute', decision, action: { tool, args } },
      context,
    );
    return result;
  }

  private isToolName(tool: string): tool is ToolName {
    return ['jira_create_issue', 'query_logs', 'execute_runbook_script', 'invoke_human_on_slack', 'meeting_interrupt'].includes(tool);
  }

  private async emitOutcome(
    correlationId: string,
    ok: boolean,
    summary: string,
    hops: number,
    toolCalls: number,
    source: 'pipeline' | 'procedure' = 'pipeline',
  ): Promise<void> {
    if (!this.eventLog) return;
    await this.eventLog.append({
      correlationId,
      ts: this.now(),
      layer: 'execution',
      source: 'internal',
      kind: 'agent_outcome',
      finalResult: { ok, summary: `${summary} (hops=${hops}, toolCalls=${toolCalls}, via:${source})` },
    }).catch(() => {});
  }
}

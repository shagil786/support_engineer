/**
 * SupervisorAgent (spec §6.4) — owns the per-request loop over the four
 * sub-agents and the ToolRunner. Never calls integrations directly.
 *
 * Pipeline: Triage → Investigator (read-only plan) → Reviewer → governed
 * action → Executor (side-effect plan), with every step verified and every
 * execution funneled through the ToolRunner (which re-checks Governance).
 * A pre-action reviewer `fail` triggers a bounded re-dance (maxReviewRetries,
 * default 1) so the planners can act on the feedback; `reask` ends the
 * request for a human; the final review never retries.
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
  /** How many times a pre-action reviewer `fail` may trigger a full re-dance
   *  (triage → investigate → review) before the request fails with the
   *  accumulated feedback. Default 1; 0 restores fail-fast. The final review
   *  (after execution) never retries. */
  maxReviewRetries?: number;
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
  maxHops: 10,
  maxTokens: 50_000,
  maxWallClockMs: 60_000,
  maxIdenticalToolCalls: 3,
  maxReviewRetries: 1,
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
  private readonly maxReviewRetries: number;
  private readonly now: () => number;
  private readonly procedures: ProcedureLibrary | undefined;
  private readonly loops = new LoopDetector();

  /** Tools whose replay cannot mutate state. Mutating steps of a learned
   *  procedure are never replayed — policy approved THIS request's action,
   *  not the procedure's historical args. */
  private static readonly READ_ONLY = new Set(['query_logs', 'jira_get_issue']);

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
    this.maxReviewRetries = Math.max(0, opts.maxReviewRetries ?? DEFAULTS.maxReviewRetries);
    this.procedures = opts.procedures;
    this.now = opts.now ?? Date.now;
  }

  async run(input: SupervisorRunInput): Promise<SupervisorRunOutput> {
    const started = this.now();
    const { governed, context, bundle } = input;
    let hops = 0;
    let toolCalls = 0;
    /** Reviewer `fail` verdicts repaired by a re-dance (for the outcome stats). */
    let reviewRetries = 0;
    /** Procedure id when a replay was attempted but degraded to the dance. */
    let attemptedProcedureId: string | undefined;

    const fail = async (
      reason: string,
      source: 'pipeline' | 'procedure' = 'pipeline',
    ): Promise<SupervisorRunOutput> => {
      await this.emitOutcome(context.correlationId, {
        ok: false,
        summary: `Request not completed: ${reason}`,
        hops,
        toolCalls,
        source,
        wallClockMs: this.now() - started,
        ...(attemptedProcedureId ? { fallbackFrom: attemptedProcedureId } : {}),
        ...(reviewRetries > 0 ? { reviewRetries } : {}),
      });
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
          attemptedProcedureId = match.procedure.id;
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
            await this.emitOutcome(context.correlationId, {
              ok: true,
              summary,
              hops,
              toolCalls,
              source: 'procedure',
              wallClockMs: this.now() - started,
              procedureId: match.procedure.id,
            });
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

    // 1–3. The pre-action dance with the reviewer-feedback retry loop:
    //    triage → investigate (read-only plan) → review. A reviewer `fail`
    //    means the trace is correctable — spend retry budget and re-run the
    //    whole dance so the planners can act on the feedback (the reviewer
    //    judges the refreshed live trace, so new investigation work is
    //    visible). `reask` means the request cannot be resolved without a
    //    human — it never retries and never executes. Caps (hops/tokens/
    //    wall clock/loops) are NOT reset by a retry; the budget widens
    //    fidelity, never the caps.
    const feedbacks: string[] = [];
    let subKind = 'unknown';
    for (;;) {
      // a. Triage
      hops++;
      if (hops > this.maxHops) return fail('hop cap reached');
      if (overTokens()) return fail('token cap exceeded');
      const triage = await this.triage.run(bundle);
      this.accumulate(context, triage);
      subKind = triage.decision.subKind;

      // b. Investigator — read-only plan
      hops++;
      if (hops > this.maxHops) return fail('hop cap reached');
      if (overTokens()) return fail('token cap exceeded');
      const inv = await this.investigator.run(bundle);
      this.accumulate(context, inv);
      for (const step of inv.decision.plan) {
        if (overWallClock()) return fail('wall clock cap exceeded');
        const r = await this.executeStep(step.tool, step.args, context, governed.decision);
        toolCalls++;
        const v = verifyResult(step.tool, r, { candidateOutput: context.candidateOutput });
        if (!v.passed) return fail(`investigation step failed verification: ${v.reason ?? 'unknown'}`);
      }

      // c. Reviewer over the trace so far — refreshed so the reviewer sees
      //    the tool_call events the dance has already emitted. Judging a
      //    pre-dance bundle would blind it to the very actions it reviews.
      hops++;
      if (hops > this.maxHops) return fail('hop cap reached');
      if (overTokens()) return fail('token cap exceeded');
      await this.refreshTrace(bundle);
      const rev = await this.reviewer.run(bundle);
      this.accumulate(context, rev);
      if (rev.decision.verdict === 'reask') {
        // Unresolvable without a human — the feedback is the answer path,
        // not a correction. No retry, no execution.
        return fail(`reviewer needs human input: ${rev.decision.feedback}`);
      }
      if (rev.decision.verdict !== 'fail') break; // pass — proceed to the action
      // A correction request: record it and retry while budget remains.
      feedbacks.push(rev.decision.feedback);
      if (reviewRetries >= this.maxReviewRetries) {
        const unique = [...new Set(feedbacks)].join(' | ');
        return fail(`reviewer rejected outcome: ${unique}`);
      }
      reviewRetries++;
    }

    // 4. The governed action itself (already approved by policy)
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    if (overTokens()) return fail('token cap exceeded');
    if (overWallClock()) return fail('wall clock cap exceeded');
    const main = await this.executeStep(governed.action.tool, governed.action.args, context, governed.decision);
    toolCalls++;
    const mainVerdict = verifyResult(governed.action.tool, main, { candidateOutput: context.candidateOutput });
    if (!mainVerdict.passed) return fail(`action failed verification: ${mainVerdict.reason ?? 'unknown'}`);

    // 5. Executor — side-effect plan (reviewer may still veto after)
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    if (overTokens()) return fail('token cap exceeded');
    const exe = await this.executor.run(bundle);
    this.accumulate(context, exe);
    for (const step of exe.decision.sideEffects) {
      if (overWallClock()) return fail('wall clock cap exceeded');
      const r = await this.executeStep(step.tool, step.args, context, governed.decision);
      toolCalls++;
      const v = verifyResult(step.tool, r, { candidateOutput: context.candidateOutput });
      if (!v.passed) return fail(`side-effect failed verification: ${v.reason ?? 'unknown'}`);
    }

    // 6. Final review — same live trace refresh.
    hops++;
    if (hops > this.maxHops) return fail('hop cap reached');
    if (overTokens()) return fail('token cap exceeded');
    await this.refreshTrace(bundle);
    const final = await this.reviewer.run(bundle);
    this.accumulate(context, final);
    const ok = final.decision.verdict !== 'fail';
    const summary = ok
      ? `Handled '${subKind}' with ${toolCalls} tool call(s). ${final.decision.feedback}`.trim()
      : `Reviewer rejected: ${final.decision.feedback}`;
    await this.emitOutcome(context.correlationId, {
      ok,
      summary,
      hops,
      toolCalls,
      source: 'pipeline',
      wallClockMs: this.now() - started,
      ...(attemptedProcedureId ? { fallbackFrom: attemptedProcedureId } : {}),
      ...(reviewRetries > 0 ? { reviewRetries } : {}),
    });
    this.loops.clear({ correlationId: context.correlationId });
    return { ok, hops, toolCalls, summary, source: 'pipeline' };
  }

  /** Add an agent run's reported usage to the request's running total.
   *  Absent usage (fallback paths, providers without usage) adds nothing —
   *  honest "no data", never a fabricated zero that would hide spend. */
  private accumulate(
    context: ToolRunnerContext,
    out: { usage?: { prompt: number; completion: number } },
  ): void {
    if (!out.usage) return;
    context.tokens.prompt += out.usage.prompt;
    context.tokens.completion += out.usage.completion;
  }

  /** Re-pull the recent-events window so reviewers judge the live trace
   *  (including tool_call events emitted by this dance), not the stale
   *  bundle assembled before it. Mirrors the pipeline's 60s window. */
  private async refreshTrace(bundle: ContextBundle): Promise<void> {
    if (!this.eventLog) return;
    const cutoff = this.now() - 60_000;
    const out: ContextBundle['recent'] = [];
    for await (const e of this.eventLog.query({ from: cutoff, to: this.now() })) {
      out.push(e);
      if (out.length >= 10) break;
    }
    if (out.length > 0) bundle.recent = out;
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
    return ['jira_get_issue', 'jira_create_issue', 'query_logs', 'execute_runbook_script', 'invoke_human_on_slack', 'meeting_interrupt'].includes(tool);
  }

  private async emitOutcome(
    correlationId: string,
    o: {
      ok: boolean;
      summary: string;
      hops: number;
      toolCalls: number;
      source: 'pipeline' | 'procedure';
      wallClockMs: number;
      procedureId?: string;
      fallbackFrom?: string;
      reviewRetries?: number;
    },
  ): Promise<void> {
    if (!this.eventLog) return;
    await this.eventLog.append({
      correlationId,
      ts: this.now(),
      layer: 'execution',
      source: 'internal',
      kind: 'agent_outcome',
      finalResult: { ok: o.ok, summary: `${o.summary} (hops=${o.hops}, toolCalls=${o.toolCalls}, via:${o.source})` },
      stats: {
        source: o.source,
        hops: o.hops,
        toolCalls: o.toolCalls,
        wallClockMs: o.wallClockMs,
        ...(o.procedureId !== undefined ? { procedureId: o.procedureId } : {}),
        ...(o.fallbackFrom !== undefined ? { fallbackFrom: o.fallbackFrom } : {}),
        ...(o.reviewRetries !== undefined ? { reviewRetries: o.reviewRetries } : {}),
      },
    }).catch(() => {});
  }
}

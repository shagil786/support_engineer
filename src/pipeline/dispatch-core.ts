/**
 * DispatchCore — the post-ingress dispatch core of the pipeline.
 *
 * Given a classified envelope that has already cleared the ingress gates
 * (injection guard, etiquette, action-etiquette confirmations), this module
 * owns HOW the work gets done:
 *  - assembly of the context bundle (per-meeting scope when the utterance
 *    carries one);
 *  - runbook offers → concrete provider action (the provider's destructive
 *    flag, not the text, drives policy);
 *  - KB-first question answering with governed log-query fallback;
 *  - the single governed.run() path shared by every routed work item;
 *  - deterministic surface post-processing: ticket status spoken from the
 *    tool_call audit payload, KB refusals tagged with the 'logs' source.
 *
 * It has NO opinion about who may speak or what counts as chatter — that is
 * the ingress's job (agent-pipeline.ts). It only ever needs the dispatch-
 * facing collaborators, which is why it does not receive MeetingNotes, the
 * classifier, the etiquette gates, or the episodic store.
 */
import type { IntentEnvelope } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import type { ContextAssembler } from '../understanding/context-assembler.js';
import { GovernedDispatch, recentEvents } from './governed-dispatch.js';
import { GroundedQuestionStage } from './grounded-question.js';
import { RunbookResolver } from './runbook-resolver.js';
import { runbookProposal, shapeProposal } from './proposal.js';
import type { DispatchContext, PipelineRouting } from './types.js';

/** The dispatch-facing collaborators. One object, constructed once. */
export interface DispatchCoreDeps {
  governed: GovernedDispatch;
  questions: GroundedQuestionStage;
  runbooks: RunbookResolver;
  assembler: ContextAssembler;
  eventLog: EventLog;
  deliverSpeech: (text: string, target?: { channel: string; threadTs: string }) => void;
  now: () => number;
}

export class DispatchCore {
  private readonly governed: GovernedDispatch;
  private readonly questions: GroundedQuestionStage;
  private readonly runbooks: RunbookResolver;
  private readonly assembler: ContextAssembler;
  private readonly eventLog: EventLog;
  private readonly deliverSpeech: (text: string, target?: { channel: string; threadTs: string }) => void;
  private readonly now: () => number;

  constructor(deps: DispatchCoreDeps) {
    this.governed = deps.governed;
    this.questions = deps.questions;
    this.runbooks = deps.runbooks;
    this.assembler = deps.assembler;
    this.eventLog = deps.eventLog;
    this.deliverSpeech = deps.deliverSpeech;
    this.now = deps.now;
  }

  /** Dispatch a cleared envelope under governance. */
  async dispatch(cid: string, envelope: IntentEnvelope, ctx: DispatchContext): Promise<PipelineRouting> {
    // Meeting utterances assemble with the per-meeting scope: the dance sees
    // what was said earlier in THIS conversation (spec §4.1 episodic recall),
    // while cross-scope procedures still short-circuit via the library.
    const bundle = await this.assembler.assemble({
      envelope,
      recent: await recentEvents(this.eventLog, this.now),
      text: ctx.text,
      ...(ctx.meetingScope ? { scope: 'perMeeting' as const } : {}),
      ...(ctx.meetingId ? { meetingId: ctx.meetingId } : {}),
    });

    const subKind = envelope.intent.kind === 'meeting_response' ? envelope.intent.subKind : undefined;

    // Runbook offers resolve to a concrete provider action; the provider's
    // destructive flag (not the text) drives policy.
    if (subKind === 'runbook_offer') {
      return this.handleRunbookOffer(cid, envelope, ctx);
    }

    // KB-first for questions: when the knowledge base can ground an answer
    // (stricter 0.4 floor — spoken answers must be genuinely about the
    // corpus, not trigram-adjacent), speak it with citations — no tool call,
    // no LLM dance. Refusals (and live-data questions, which never touch the
    // static KB) fall through to the governed log-query path below, so
    // live-data questions still work exactly as before.
    const question = await this.questions.offer(cid, envelope, ctx.text, ctx.thread);
    if (question.answered) return question.answered;

    // Questions propose a read-only log query; anything else routed here
    // proposes speaking an interrupt — the shaper owns both shapes.
    const proposal = shapeProposal(envelope, question.isQuestion);

    const outcome = await this.governed.run({
      cid,
      speakerId: ctx.speakerId,
      envelope,
      action: proposal,
      bundle,
      ...(ctx.thread ? { thread: ctx.thread } : {}),
    });
    if (outcome.kind === 'executed' && proposal.tool === 'jira_get_issue') {
      // Deterministic surface: the ticket status is read from the tool_call
      // audit event's payload (the audit spine is the single source of
      // truth), then spoken — same pattern as feedback filings.
      for await (const e of this.eventLog.query({ correlationId: cid })) {
        if (e.kind === 'tool_call' && e.tool === 'jira_get_issue' && e.result.ok) {
          const d = e.result.data as { key?: string; summary?: string; status?: string } | undefined;
          if (d?.key) {
            const line = `${d.key} ('${d.summary ?? ''}') is ${d.status ?? 'unknown'}.`;
            this.deliverSpeech(line, ctx.thread ? { channel: ctx.thread.channel, threadTs: ctx.thread.ts } : undefined);
            return { ...outcome.routing, answer: line, answerSource: 'jira' as const };
          }
        }
      }
    }
    // KB refusal → the governed log query IS the answer source ('logs').
    if (outcome.kind === 'executed' && question.kbRefused && proposal.tool === 'query_logs') {
      return { ...outcome.routing, answerSource: 'logs' };
    }
    return outcome.routing;
  }

  private async handleRunbookOffer(
    cid: string,
    envelope: IntentEnvelope,
    ctx: DispatchContext,
  ): Promise<PipelineRouting> {
    const wanted = envelope.entities.runbookIds?.[0];
    const resolved = await this.runbooks.resolve(wanted, ctx.text);
    if (!resolved) {
      return { routed: 'pipeline', correlationId: cid, ok: false, reason: 'no matching runbook action' };
    }
    const proposal = runbookProposal(resolved);
    const enriched: IntentEnvelope = {
      ...envelope,
      entities: { ...envelope.entities, runbookIds: [resolved.id], runbookDestructive: resolved.destructive },
    };

    const outcome = await this.governed.run({
      cid,
      speakerId: ctx.speakerId,
      envelope: enriched,
      action: proposal,
      ...(ctx.thread ? { thread: ctx.thread } : {}),
    });
    return outcome.routing;
  }
}

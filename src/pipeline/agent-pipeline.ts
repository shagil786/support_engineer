/**
 * OrchestratedPipeline (spec §3) — the ingress and composition root of the
 * five-layer pipeline, kept deliberately thin.
 *
 * It owns only what an entry point must own:
 *  - classify → route (etiquette intents and unknown chatter go straight to
 *    the legacy cascade — the pipeline does not intercept what works);
 *  - per-meeting episodic recording of every routed utterance;
 *  - honest degradation: ANY pipeline failure (LLM transport, store, gate)
 *    falls back to the legacy cascade — the meeting never hangs.
 *
 * The change-axes live in focused collaborators:
 *  - `route.ts` — legacy-vs-pipeline routing policy
 *  - `proposal.ts` — envelope → tool proposal shaping (the one place to add
 *    proposal policies later)
 *  - `GroundedQuestionStage` — KB-first answering (question axis)
 *  - `RunbookResolver` — runbook_offer → concrete provider action
 *  - `GovernedDispatch` — the single policy → safety → approval → supervisor
 *    path shared by questions, runbook offers, envelopes, and approved
 *    re-dispatches
 *
 * Surface envelopes (Jira/Slack/cron webhooks, proactive anomalies) enter
 * through processEnvelope() with the same governance guarantees.
 */
import { correlationId } from '../event-log/correlation.js';
import type { IntentEnvelope } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import type { ToolName } from '../support-voice-agent/tools/types.js';
import type { SupportVoiceAgent } from '../support-voice-agent/agent.js';
import type { RunbookProvider } from '../support-voice-agent/integrations/runbook.js';
import type { GroundedAnswerer } from '../understanding/grounded-answerer.js';
import type { IntentClassifier } from '../understanding/intent-classifier.js';
import type { ContextAssembler } from '../understanding/context-assembler.js';
import type { EpisodicMemory } from '../understanding/memory/episodic.js';
import type { PolicyEngine } from '../governance/policy-engine.js';
import type { SafetyNet } from '../governance/safety-net/index.js';
import { ApprovalGate, type ApprovalSnapshot } from '../governance/approval-gate.js';
import type { SupervisorAgent } from '../execution/supervisor.js';
import type { ToolRunner } from '../execution/tool-runner.js';
import type { OutcomeRecorder } from '../learning/outcome-recorder.js';
import { GovernedDispatch, recentEvents } from './governed-dispatch.js';
import { GroundedQuestionStage } from './grounded-question.js';
import { RunbookResolver } from './runbook-resolver.js';
import { routeIntent } from './route.js';
import { runbookProposal, shapeProposal } from './proposal.js';
import type { DispatchContext, PipelineRouting } from './types.js';

export type { ApprovedAction, PipelineRouting } from './types.js';

export interface OrchestratedPipelineOptions {
  legacy: SupportVoiceAgent;
  classifier: IntentClassifier;
  assembler: ContextAssembler;
  policyEngine: PolicyEngine;
  safetyNet: SafetyNet;
  approvals: ApprovalGate;
  supervisor: SupervisorAgent;
  toolRunner: ToolRunner;
  eventLog: EventLog;
  outcomeRecorder?: OutcomeRecorder;
  runbookProvider?: RunbookProvider;
  /** Where pipeline-generated speech is delivered (TTS bridge). */
  deliverSpeech?: (text: string, target?: { channel: string; threadTs: string }) => void;
  /** Grounded answerer over the knowledge base. When wired, question intents
   *  are answered KB-first (cited speech, no tools); KB refusals fall through
   *  to the governed log-query path. Unwired → questions go straight to the
   *  governed path (previous behavior). */
  answerer?: GroundedAnswerer;
  /** Episodic memory (optional): when wired, routed meeting utterances are
   *  recorded as per-meeting memories and assembled with the per-meeting
   *  scope, so the dance sees this conversation's history. */
  episodic?: EpisodicMemory;
  now?: () => number;
}

export class OrchestratedPipeline {
  private readonly legacy: SupportVoiceAgent;
  private readonly classifier: IntentClassifier;
  private readonly assembler: ContextAssembler;
  private readonly approvals: ApprovalGate;
  private readonly eventLog: EventLog;
  private readonly episodic?: EpisodicMemory;
  private readonly deliverSpeech: (text: string, target?: { channel: string; threadTs: string }) => void;
  private readonly now: () => number;
  private readonly governed: GovernedDispatch;
  private readonly questions: GroundedQuestionStage;
  private readonly runbooks: RunbookResolver;

  constructor(opts: OrchestratedPipelineOptions) {
    this.legacy = opts.legacy;
    this.classifier = opts.classifier;
    this.assembler = opts.assembler;
    this.approvals = opts.approvals;
    this.eventLog = opts.eventLog;
    this.episodic = opts.episodic;
    this.deliverSpeech = opts.deliverSpeech ?? ((_t, _target) => undefined);
    this.now = opts.now ?? Date.now;
    this.governed = new GovernedDispatch({
      policyEngine: opts.policyEngine,
      safetyNet: opts.safetyNet,
      approvals: opts.approvals,
      supervisor: opts.supervisor,
      assembler: opts.assembler,
      eventLog: opts.eventLog,
      ...(opts.outcomeRecorder ? { outcomeRecorder: opts.outcomeRecorder } : {}),
      now: this.now,
    });
    this.questions = new GroundedQuestionStage({
      ...(opts.answerer ? { answerer: opts.answerer } : {}),
      eventLog: opts.eventLog,
      deliverSpeech: this.deliverSpeech,
      now: this.now,
    });
    this.runbooks = new RunbookResolver(opts.runbookProvider);
  }

  /** Entry point for live meeting utterances. */
  async processUtterance(
    speakerId: string,
    text: string,
    ts = this.now(),
    meetingChannel?: string,
    threadTs?: string,
  ): Promise<PipelineRouting> {
    const cid = correlationId(ts);
    try {
      const envelope = await this.classifier.classify(
        { text, source: 'meeting', ts, speakerId },
        { correlationId: cid },
      );

      // Etiquette intents belong to the legacy cascade, always — and so does
      // unrecognized chatter (the cascade's greeting/ignore policy owns it).
      if (routeIntent(envelope) === 'legacy') {
        this.legacy.processUtterance(speakerId, text, ts);
        return { routed: 'legacy', correlationId: cid, legacyFallback: false };
      }

      // Meeting context: every routed utterance becomes a per-meeting
      // memory (durable when the platform wires a perMeetingPath), so the
      // next utterance's dance sees this conversation's history. The meeting
      // key is the channel when one is provided (Slack threads), else the
      // speaker (console/HTTP default).
      const meetingId = meetingChannel ? `channel:${meetingChannel}` : `meeting:${speakerId}`;
      try {
        await this.episodic?.record('perMeeting', { id: cid, text, metadata: { speaker: speakerId } }, { meetingId });
      } catch {
        // Memory failure must not fail the request.
      }
      return await this.dispatch(cid, envelope, {
        correlationId: cid,
        speakerId,
        text,
        meetingScope: true,
        meetingId,
        ...(meetingChannel ? { thread: { channel: meetingChannel, ts: threadTs ?? String(ts) } } : {}),
      });
    } catch (e) {
      // Honest degradation: pipeline failure → legacy cascade.
      this.legacy.processUtterance(speakerId, text, ts);
      return {
        routed: 'legacy',
        correlationId: cid,
        ok: false,
        reason: `pipeline failed, legacy fallback: ${e instanceof Error ? e.message : String(e)}`,
        legacyFallback: true,
      };
    }
  }

  /** Entry point for surface envelopes (webhooks, proactive alerts). */
  async processEnvelope(
    envelope: IntentEnvelope,
    proposed: { tool: ToolName; args: Record<string, unknown> },
  ): Promise<PipelineRouting> {
    const cid = correlationId(envelope.rawContext.ts || this.now());
    try {
      const payloadText =
        typeof envelope.rawContext.payload === 'object' && envelope.rawContext.payload !== null &&
        typeof (envelope.rawContext.payload as { text?: unknown }).text === 'string'
          ? (envelope.rawContext.payload as { text: string }).text
          : '';
      return await this.dispatch(cid, envelope, { correlationId: cid, speakerId: envelope.entities.speakerId ?? 'surface', text: payloadText });
    } catch (e) {
      return {
        routed: 'legacy',
        correlationId: cid,
        ok: false,
        reason: `pipeline failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /** Record a signature on a pending approval. */
  signApproval(approvalId: string, signerRole: string, signerId?: string): ApprovalSnapshot {
    return this.approvals.sign(approvalId, signerRole, signerId);
  }

  /** Execute a staged action once its approval is granted. */
  async executeApproved(approvalId: string, correlationId: string): Promise<PipelineRouting> {
    return this.governed.executeApproved(approvalId, correlationId);
  }

  /* ------------------------- internals ------------------------- */

  private async dispatch(
    cid: string,
    envelope: IntentEnvelope,
    ctx: DispatchContext,
  ): Promise<PipelineRouting> {
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
    // KB refusal → the governed log query IS the answer source ('logs').
    if (outcome.kind === 'executed' && question.kbRefused) {
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
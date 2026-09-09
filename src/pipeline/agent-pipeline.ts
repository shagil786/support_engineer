/**
 * OrchestratedPipeline (spec §3) — the ingress and composition root of the
 * five-layer pipeline, kept deliberately thin.
 *
 * It owns only what an entry point must own:
 *  - guard → classify → route (etiquette, urgency, governed work; unknown
 *    chatter is recorded for the meeting summary and acknowledged);
 *  - per-meeting episodic recording of every routed utterance;
 *  - honest degradation: ANY pipeline failure (LLM transport, store, gate)
 *    answers with a spoken failure notice — the meeting never hangs.
 *
 * One brain: the legacy cascade is gone. Urgent signals (critical
 * declarations, the alert feed, the injection guard) are UrgencyStage; the
 * meeting summary is MeetingNotes.
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
 *  - `DispatchCore` — the post-ingress dispatch core: assembly, KB-first
 *    offering, runbook resolution, and governed execution
 *  - `FeedbackFilingFlow` — confirmed verbal feedback → governed Jira filing
 *
 * Surface envelopes (Jira/Slack/cron webhooks, proactive anomalies) enter
 * through processEnvelope() with the same governance guarantees.
 */
import { correlationId } from '../event-log/correlation.js';
import type { IntentEnvelope } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import type { ToolName } from '../support-voice-agent/tools/types.js';
import type { RunbookProvider } from '../support-voice-agent/integrations/runbook.js';
import type { Guardrails } from '../support-voice-agent/guardrails.js';
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
import { GovernedDispatch } from './governed-dispatch.js';
import { GroundedQuestionStage } from './grounded-question.js';
import { RunbookResolver } from './runbook-resolver.js';
import { routeIntent } from './route.js';
import { EtiquetteGate } from './etiquette-gate.js';
import { ActionEtiquetteStage } from './action-etiquette.js';
import { UrgencyStage } from './urgency-stage.js';
import { DispatchCore } from './dispatch-core.js';
import { FeedbackFilingFlow } from './feedback-filing.js';
import type { MeetingNotes } from '../meeting/notes.js';
import type { DispatchContext, PipelineRouting } from './types.js';

export type { ApprovedAction, PipelineRouting } from './types.js';

export interface OrchestratedPipelineOptions {
  /** Meeting-summary state: the single record every stage feeds. */
  notes: MeetingNotes;
  /** Layer 4 escalation ports (injection attempts page security). */
  guardrails?: Guardrails;
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
  /** How long "agent, shut up" mutes the agent (EtiquetteGate default: 5 min,
   *  matching the legacy cascade's muteDurationMs). */
  muteDurationMs?: number;
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
  private readonly notes: MeetingNotes;
  /** Urgent-signal surface: hosts feed P0/P1 alerts here. */
  readonly urgency: UrgencyStage;
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
  private readonly etiquette: EtiquetteGate;
  private readonly actionEtiquette: ActionEtiquetteStage;
  private readonly core: DispatchCore;
  private readonly filings: FeedbackFilingFlow;

  constructor(opts: OrchestratedPipelineOptions) {
    this.notes = opts.notes;
    this.classifier = opts.classifier;
    this.urgency = new UrgencyStage({
      notes: opts.notes,
      ...(opts.guardrails ? { guardrails: opts.guardrails } : {}),
      deliverSpeech: (text) => this.deliverSpeech(text),
      ...(opts.now ? { now: opts.now } : {}),
    });
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
    this.etiquette = new EtiquetteGate({
      deliverSpeech: (text) => this.deliverSpeech(text),
      ...(opts.muteDurationMs !== undefined ? { muteDurationMs: opts.muteDurationMs } : {}),
    });
    // MeetingNotes is the single summary record; every stage feeds it.
    this.actionEtiquette = new ActionEtiquetteStage({
      sink: {
        addFeedback: (item) => this.notes.addFeedback(item),
        addConcern: (item) => this.notes.addConcern(item),
      },
      deliverSpeech: (text) => this.deliverSpeech(text),
    });
    this.core = new DispatchCore({
      governed: this.governed,
      questions: this.questions,
      runbooks: this.runbooks,
      assembler: this.assembler,
      eventLog: this.eventLog,
      deliverSpeech: (text, target) => this.deliverSpeech(text, target),
      now: this.now,
    });
    this.filings = new FeedbackFilingFlow({
      governed: this.governed,
      assembler: this.assembler,
      eventLog: this.eventLog,
      actionEtiquette: this.actionEtiquette,
      notes: this.notes,
      deliverSpeech: (text) => this.deliverSpeech(text),
      now: this.now,
    });
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
      // Layer 4 before routing: the injection guard sees EVERY input — in
      // the two-brain era pipeline-routed text never met it.
      const injection = this.urgency.guard(speakerId, text);
      if (injection.handled) {
        return { routed: 'etiquette', correlationId: cid, ok: injection.ok, ...(injection.reason ? { reason: injection.reason } : {}) };
      }

      const envelope = await this.classifier.classify(
        { text, source: 'meeting', ts, speakerId },
        { correlationId: cid },
      );

      // Talk-permission (mute/wake) belongs to the pipeline's gate in
      // orchestrated mode: one owner of the mute state, and the gate's
      // window also swallows pipeline-routed work (the ownership bug this
      // fixes: a muted meeting used to still get KB answers).
      const etiquette = this.etiquette.offer(speakerId, text, ts);
      if (etiquette.handled) {
        return { routed: 'etiquette', correlationId: cid, ...(etiquette.ok !== undefined ? { ok: etiquette.ok } : {}), ...(etiquette.reason ? { reason: etiquette.reason } : {}) };
      }

      // The summary records every post-gate utterance (participants + text).
      this.notes.recordUtterance(speakerId, text, ts);

      // Confirmed priority/negation answers while a feedback filing is
      // pending — intercepted BEFORE routing: a bare "P2" classifies as
      // unknown and would otherwise reach the cascade as lost chatter.
      const confirm = this.actionEtiquette.offerConfirmation(speakerId, text, ts);
      if (confirm.handled) {
        if (confirm.filing) {
          return await this.filings.file(cid, confirm.filing, speakerId, meetingChannel, threadTs);
        }
        return { routed: 'etiquette', correlationId: cid, ...(confirm.ok !== undefined ? { ok: confirm.ok } : {}), ...(confirm.reason ? { reason: confirm.reason } : {}) };
      }

      // Action etiquette (critical, complaint, feedback) and unrecognized
      // chatter belong to the legacy cascade (its greeting/ignore policy
      // owns it). Critical declarations were offered to the gate first and
      // passed through by design — urgent signals break through mutes.
      if (routeIntent(envelope) === 'legacy') {
        // Urgent declarations break through everything, exactly as the
        // cascade guaranteed — recorded, barged in, break mutes.
        const critical = this.urgency.criticalFrom(text, speakerId);
        if (critical.handled) {
          return { routed: 'etiquette', correlationId: cid, ok: critical.ok, ...(critical.reason ? { reason: critical.reason } : {}) };
        }
        // Complaint/feedback are claimed by the pipeline's action stage —
        // confirmations end in GOVERNED Jira filing.
        const action = this.actionEtiquette.offerIntent(envelope, speakerId, text, ts);
        if (action.handled) {
          return { routed: 'etiquette', correlationId: cid, ...(action.ok !== undefined ? { ok: action.ok } : {}), ...(action.reason ? { reason: action.reason } : {}) };
        }
        // Unrecognized chatter: recorded above, never spoken over (the
        // cascade's deep-dive silence policy, owned here).
        return { routed: 'legacy', correlationId: cid, ok: true, reason: 'chatter_noted', legacyFallback: false };
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
      return await this.core.dispatch(cid, envelope, {
        correlationId: cid,
        speakerId,
        text,
        meetingScope: true,
        meetingId,
        ...(meetingChannel ? { thread: { channel: meetingChannel, ts: threadTs ?? String(ts) } } : {}),
      });
    } catch (e) {
      // Honest degradation: say so. The meeting never hangs and no
      // ungoverned second brain silently takes over.
      const message = e instanceof Error ? e.message : String(e);
      this.deliverSpeech("I couldn't process that just now — try again in a moment.");
      return {
        routed: 'legacy',
        correlationId: cid,
        ok: false,
        reason: `pipeline failed: ${message}`,
        legacyFallback: false,
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
      return await this.core.dispatch(cid, envelope, { correlationId: cid, speakerId: envelope.entities.speakerId ?? 'surface', text: payloadText });
    } catch (e) {
      return {
        routed: 'legacy',
        correlationId: cid,
        ok: false,
        reason: `pipeline failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /** Mute-state query (hosts/tests): the gate is the single owner. */
  isMuted(ts = this.now()): boolean {
    return this.etiquette.isMuted(ts);
  }

  /** The pending approval queue (hosts/tests): the gate is the single owner
   *  of the state; this is the read-only passthrough queue surfaces use. */
  listPendingApprovals() {
    return this.governed.listPendingApprovals();
  }

  /** Subscribe to approval-queue mutations (SSE surfaces) — delegated to the
   *  gate through the dispatch, the single owner of the approval state. */
  onApprovalQueueChange(fn: () => void): () => void {
    return this.governed.onApprovalQueueChange(fn);
  }

  /** The correlation id a staged action executes under (queue surfaces pass
   *  it to executeApproved). Unknown ids return undefined. */
  stagedCorrelation(approvalId: string): string | undefined {
    return this.governed.stagedCorrelation(approvalId);
  }
  /** Record a signature with server-side identity resolution — the gate
   *  resolves the signer's role from the platform registry, rank-checks it,
   *  and throws SignerRoleError on insufficient privilege. */
  signApprovalAs(approvalId: string, signerId: string): ApprovalSnapshot {
    return this.approvals.signAs(approvalId, signerId);
  }

  /** Execute a staged action once its approval is granted. */
  async executeApproved(approvalId: string, correlationId: string): Promise<PipelineRouting> {
    return this.governed.executeApproved(approvalId, correlationId);
  }

}
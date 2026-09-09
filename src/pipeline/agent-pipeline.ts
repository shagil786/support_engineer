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
import { GovernedDispatch, recentEvents } from './governed-dispatch.js';
import { GroundedQuestionStage } from './grounded-question.js';
import { RunbookResolver } from './runbook-resolver.js';
import { routeIntent } from './route.js';
import { EtiquetteGate } from './etiquette-gate.js';
import { ActionEtiquetteStage, type PendingFiling } from './action-etiquette.js';
import { UrgencyStage } from './urgency-stage.js';
import type { MeetingNotes } from '../meeting/notes.js';
import { runbookProposal, shapeProposal } from './proposal.js';
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
  }

  /** A confirmed verbal-feedback filing, dispatched under governance: the
   *  same bug the legacy cascade filed directly (no policy, no audit), now
   *  policy-evaluated, SafetyNet-checked, and audited. Extracts the issue
   *  key from the tool_call audit event (deterministic), not from the
   *  supervisor's free-text summary. */
  private async dispatchFeedbackFiling(
    cid: string,
    filing: PendingFiling,
    speakerId: string,
    meetingChannel?: string,
    threadTs?: string,
  ): Promise<PipelineRouting> {
    const action = ActionEtiquetteStage.filingAction(filing);
    const envelope: IntentEnvelope = {
      intent: { kind: 'meeting_response', subKind: 'feedback' },
      confidence: 1,
      entities: { speakerId },
      rawContext: { source: 'internal', ts: this.now(), payload: { synthetic: 'feedback_filing' } },
    };
    const meetingId = meetingChannel ? `channel:${meetingChannel}` : `meeting:${speakerId}`;
    void meetingId;
    const bundle = await this.assembler.assemble({ envelope, recent: await recentEvents(this.eventLog, this.now) });
    const outcome = await this.governed.run({
      cid,
      speakerId,
      envelope,
      action,
      bundle,
      ...(meetingChannel ? { thread: { channel: meetingChannel, ts: threadTs ?? String(this.now()) } } : {}),
    });

    // Terminal note for the summary sink. On execution, the key comes from
    // the tool_call event's data payload (deterministic extraction).
    let jiraKey: string | undefined;
    let ok = false;
    let reason: string | undefined;
    if (outcome.kind === 'executed') {
      ok = outcome.routing.ok === true;
      reason = outcome.routing.reason;
      if (ok) {
        for await (const e of this.eventLog.query({ correlationId: cid })) {
          if (e.kind === 'tool_call' && e.tool === 'jira_create_issue' && e.result.ok) {
            const data = e.result.data as { ticket_id?: string } | undefined;
            jiraKey = data?.ticket_id;
          }
        }
      }
    } else if (outcome.kind === 'staged') {
      ok = true;
      reason = `approval staged: ${outcome.routing.approvalId ?? ''}`;
    } else {
      ok = false;
      reason = outcome.routing.reason;
    }

    // Record in the sink at the terminal point (cascade parity), speak the
    // outcome, and return the routing (approvalId included when staged).
    this.actionEtiquette.completeFiling(filing, { jiraKey });
    if (jiraKey !== undefined) {
      // The summary's Jira-change record: the audit spine stays the source of
      // truth, this is the meeting-facing view.
      this.notes.recordJiraChange('created', jiraKey, `Bug filed from verbal feedback (${filing.severity})`);
      this.deliverSpeech?.(`Filed ${jiraKey} (${filing.severity}).`);
    } else if (ok) {
      this.deliverSpeech?.(`Feedback noted for filing (${filing.severity}) — approval staged.`);
    } else {
      this.deliverSpeech?.("I couldn't file that just now.");
    }
    return {
      routed: 'pipeline',
      correlationId: cid,
      ok,
      ...(reason ? { reason } : {}),
      ...(outcome.kind === 'staged' && outcome.routing.approvalId
        ? { approvalId: outcome.routing.approvalId, approvalStatus: 'pending' as const }
        : {}),
    };
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
          return await this.dispatchFeedbackFiling(cid, confirm.filing, speakerId, meetingChannel, threadTs);
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
      return await this.dispatch(cid, envelope, {
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

  /** Mute-state query (hosts/tests): the gate is the single owner. */
  isMuted(ts = this.now()): boolean {
    return this.etiquette.isMuted(ts);
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
/**
 * ActionEtiquetteStage — vague complaints and verbal feedback as a
 * pipeline-owned stage (two-brain consolidation, pass two).
 *
 * Why: in the legacy cascade these paths end in a DIRECT jiraClient
 * createIssue — no policy engine, no SafetyNet, no audit event. Here the
 * conversational semantics are identical (paraphrase → "Should I file a
 * bug? What priority?" → confirm/negate; complaints ask for specifics)
 * but a confirmed filing is returned to the pipeline as a proposed action
 * and goes through GOVERNED dispatch — policy, SafetyNet, governance and
 * tool_call audit events in the spine.
 *
 * The confirm loop is state-driven like the cascade: "P2" classifies as
 * nothing useful, so the stage intercepts priority/negation answers while
 * a filing is pending, before routeIntent sends them to the cascade as
 * chatter.
 *
 * Notes feed the meeting summary through the FeedbackSink port; the
 * pipeline wires the legacy agent (or any host) as the sink so war-room
 * summaries keep collecting feedback and concerns.
 */
import {
  isFeedback,
  isNegation,
  isVagueTechnicalComplaint,
  paraphraseFeedback,
  parsePriority,
} from '../support-voice-agent/heuristics.js';
import { jiraPriorityName } from '../support-voice-agent/integrations/jira.js';
import type { Severity } from '../support-voice-agent/types.js';
import type { ProposedAction } from '../governance/decision.js';
import type { IntentEnvelope } from '../event-log/types.js';

/** Where the stage records notes. Implemented by hosts that build meeting
 *  summaries (the legacy agent's feedbackItems/concerns lists). */
export interface FeedbackSink {
  addFeedback(item: { at: number; speakerId: string; original: string; paraphrase: string; jiraKey?: string }): void;
  addConcern(item: { at: number; speakerId: string; text: string }): void;
}

/** A confirmed filing, returned to the pipeline for governed dispatch. */
export interface PendingFiling {
  speakerId: string;
  /** Timestamp of the ORIGINAL feedback utterance. */
  at: number;
  original: string;
  paraphrase: string;
  severity: Severity;
}

export interface ActionOfferResult {
  handled: boolean;
  ok?: boolean;
  reason?: string;
  /** Present when the utterance confirmed a pending filing and the pipeline
   *  must dispatch it through governance. */
  filing?: PendingFiling;
}

export interface ActionEtiquetteStageOptions {
  sink?: FeedbackSink;
  deliverSpeech?: (text: string) => void;
}

export class ActionEtiquetteStage {
  private pending: { paraphrase: string; original: string; speakerId: string; at: number } | null = null;
  private readonly sink?: FeedbackSink;
  private readonly deliverSpeech?: (text: string) => void;

  constructor(opts: ActionEtiquetteStageOptions = {}) {
    this.sink = opts.sink;
    this.deliverSpeech = opts.deliverSpeech;
  }

  /**
   * Priority/negation answers while a filing is pending. Runs BEFORE
   * routing — a bare "P2" classifies as unknown and would otherwise reach
   * the legacy cascade as chatter, losing the confirmation.
   */
  offerConfirmation(_speakerId: string, text: string, ts: number): ActionOfferResult {
    if (!this.pending) return { handled: false };
    const severity = parsePriority(text);
    if (severity) {
      const p = this.pending;
      this.pending = null;
      return {
        handled: true,
        ok: true,
        reason: 'feedback_filing',
        filing: { speakerId: p.speakerId, at: p.at, original: p.original, paraphrase: p.paraphrase, severity },
      };
    }
    if (isNegation(text)) {
      const p = this.pending;
      this.pending = null;
      this.sink?.addFeedback({ at: p.at, speakerId: p.speakerId, original: p.original, paraphrase: p.paraphrase });
      this.deliverSpeech?.("Got it, I won't file anything.");
      return { handled: true, ok: true, reason: 'feedback_declined' };
    }
    return { handled: false };
  }

  /**
   * Complaint/feedback intents. Runs when routeIntent sends the utterance
   * to the legacy cascade: the stage claims these two action paths first.
   */
  offerIntent(envelope: IntentEnvelope, speakerId: string, text: string, ts: number): ActionOfferResult {
    const subKind = envelope.intent.kind === 'meeting_response' ? envelope.intent.subKind : undefined;
    if (subKind !== 'complaint' && subKind !== 'feedback') return { handled: false };

    if (subKind === 'feedback' || isFeedback(text)) {
      const paraphrase = paraphraseFeedback(text);
      this.pending = { paraphrase, original: text, speakerId, at: ts };
      // No sink record yet: the cascade records the item only at a terminal
      // point (confirm/negate), and completeFiling() closes the loop here.
      this.deliverSpeech?.(`Got it — "${paraphrase}" Should I create a Jira bug for this? What priority?`);
      return { handled: true, ok: true, reason: 'feedback_offered' };
    }

    // Vague complaint: note it and ask for specifics (cascade parity).
    this.sink?.addConcern({ at: ts, speakerId, text });
    this.deliverSpeech?.("Sounds like something's off. Which service, and what error are you seeing?");
    return { handled: true, ok: true, reason: 'complaint_noted' };
  }

  /** True when a vague complaint phrasing exists in the text (used by the
   *  pipeline to keep step-8 parity for complaint-classified chatter). */
  static isVagueComplaint(text: string): boolean {
    return isVagueTechnicalComplaint(text);
  }

  /** The governed action for a confirmed filing: the same bug the legacy
   *  agent filed directly, now as an auditable proposed action. */
  static filingAction(filing: PendingFiling): ProposedAction {
    return {
      tool: 'jira_create_issue',
      args: {
        summary: `[Feedback] ${filing.paraphrase}`,
        description: `Original: "${filing.original}"\nFrom: ${filing.speakerId}\nPriority per requester: ${filing.severity}`,
        priority: jiraPriorityName(filing.severity),
        issue_type: 'Bug',
      },
    };
  }

  /** Record the filing outcome in the summary sink (called by the pipeline
   *  once dispatch resolves — with the issue key when executed). */
  completeFiling(filing: PendingFiling, outcome: { jiraKey?: string } = {}): void {
    this.sink?.addFeedback({
      at: filing.at,
      speakerId: filing.speakerId,
      original: filing.original,
      paraphrase: filing.paraphrase,
      ...(outcome.jiraKey !== undefined ? { jiraKey: outcome.jiraKey } : {}),
    });
  }
}

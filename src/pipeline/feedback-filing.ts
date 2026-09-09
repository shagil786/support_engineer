/**
 * FeedbackFilingFlow — the confirmed verbal-feedback → GOVERNED Jira filing
 * path, extracted from the ingress so the composition root stays thin.
 *
 * A confirmed feedback filing is dispatched under the same governance as
 * every other action: policy-evaluated, SafetyNet-checked, audited. The
 * issue key is extracted from the tool_call audit event (deterministic),
 * never from the supervisor's free-text summary. The MeetingNotes sink and
 * the spoken confirmations are the meeting-facing view; the audit spine
 * stays the source of truth.
 */
import type { IntentEnvelope } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import { ActionEtiquetteStage, type PendingFiling } from './action-etiquette.js';
import { GovernedDispatch, recentEvents } from './governed-dispatch.js';
import type { ContextAssembler } from '../understanding/context-assembler.js';
import type { PipelineRouting } from './types.js';

/** The filing-facing collaborators. */
export interface FeedbackFilingDeps {
  governed: GovernedDispatch;
  assembler: ContextAssembler;
  eventLog: EventLog;
  actionEtiquette: ActionEtiquetteStage;
  notes: {
    recordJiraChange: (kind: 'created', key: string, summary: string) => void;
  };
  deliverSpeech: (text: string) => void;
  now: () => number;
}

export class FeedbackFilingFlow {
  private readonly governed: GovernedDispatch;
  private readonly assembler: ContextAssembler;
  private readonly eventLog: EventLog;
  private readonly actionEtiquette: ActionEtiquetteStage;
  private readonly notes: { recordJiraChange: (kind: 'created', key: string, summary: string) => void };
  private readonly deliverSpeech: (text: string) => void;
  private readonly now: () => number;

  constructor(deps: FeedbackFilingDeps) {
    this.governed = deps.governed;
    this.assembler = deps.assembler;
    this.eventLog = deps.eventLog;
    this.actionEtiquette = deps.actionEtiquette;
    this.notes = deps.notes;
    this.deliverSpeech = deps.deliverSpeech;
    this.now = deps.now;
  }

  /** A confirmed verbal-feedback filing, dispatched under governance: the
   *  same bug the legacy cascade filed directly (no policy, no audit), now
   *  policy-evaluated, SafetyNet-checked, and audited. */
  async file(
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
      this.deliverSpeech(`Filed ${jiraKey} (${filing.severity}).`);
    } else if (ok) {
      this.deliverSpeech(`Feedback noted for filing (${filing.severity}) — approval staged.`);
    } else {
      this.deliverSpeech("I couldn't file that just now.");
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
}

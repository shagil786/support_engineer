/** UrgencyStage — urgent signals, owned by the pipeline (one-brain pass).
 *
 *  Three duties moved out of the legacy cascade:
 *   1. The prompt-injection guard (Layer 4). In the two-brain era it lived
 *      inside the cascade, so pipeline-routed text (questions, runbooks)
 *      NEVER met it — a real hole this closes: the guard now runs before
 *      routing, on every input.
 *   2. Spoken critical declarations ("this is a P1") — detected, recorded,
 *      barged in. Incident filing is a governed path the pipeline proposes;
 *      this stage only records and speaks.
 *   3. The public alert feed (P0/P1 signals from CloudWatch/Jira/monitors):
 *      recorded, barged in when severe. The legacy auto-ticket creation is
 *      NOT carried over — incidents are filed through governed paths, not
 *      un-audited background writes.
 *
 *  Urgent speech is delivered through the bare deliverSpeech port, which
 *  bypasses the EtiquetteGate — urgent signals break through mutes, exactly
 *  as the legacy cascade guaranteed.
 */
import * as h from '../support-voice-agent/heuristics.js';
import { Guardrails } from '../support-voice-agent/guardrails.js';
import type { AlertSignal, Severity } from '../support-voice-agent/types.js';
import type { MeetingNotes } from '../meeting/notes.js';

export interface UrgencyStageOptions {
  notes: MeetingNotes;
  /** Layer 4 escalation ports (security paging for injection attempts). */
  guardrails?: Guardrails;
  deliverSpeech: (text: string) => void;
  now?: () => number;
}

export interface UrgencyOutcome {
  /** True when the utterance was handled before routing. */
  handled: boolean;
  ok?: boolean;
  reason?: string;
}

export class UrgencyStage {
  private readonly notes: MeetingNotes;
  private readonly guardrails?: Guardrails;
  private readonly deliverSpeech: (text: string) => void;
  private readonly now: () => number;

  constructor(opts: UrgencyStageOptions) {
    this.notes = opts.notes;
    this.guardrails = opts.guardrails;
    this.deliverSpeech = opts.deliverSpeech;
    this.now = opts.now ?? Date.now;
  }

  /** Detect + handle a spoken critical declaration ("this is a P1").
   *  handled:false when the text is not one — the caller continues routing.
   *  Recorded for the summary, barged in urgently (breaks through mutes). */
  criticalFrom(text: string, _speakerId: string): UrgencyOutcome {
    if (!h.isCriticalDeclaration(text)) return { handled: false };
    const severity: Severity = /\bp0\b/i.test(text) ? 'P0' : 'P1';
    this.notes.addAlert({ severity, source: 'meeting', summary: text, ts: this.now() });
    this.deliverSpeech(`Excuse me, urgent alert: "${text}". Raising this as ${severity} now.`);
    return { handled: true, ok: true, reason: `critical_${severity.toLowerCase()}` };
  }

  /** Layer 4 before routing: refuse, record, page security once. */
  guard(speakerId: string, text: string): UrgencyOutcome {
    if (!h.isPromptInjection(text)) return { handled: false };
    this.notes.addAlert({ severity: 'P1', source: 'security', summary: `prompt injection attempt from ${speakerId}`, ts: this.now() });
    this.deliverSpeech("Sorry, I can't do that.");
    if (this.guardrails) {
      void this.guardrails.pageSecurity(`Prompt-injection attempt in meeting by ${speakerId}: "${text.slice(0, 200)}"`);
    }
    return { handled: true, ok: false, reason: 'injection_refused' };
  }

  /** The public alert feed (P0/P1 signals). Severe alerts barge in —
   *  urgent signals break through mutes. */
  ingestAlert(alert: AlertSignal): void {
    this.notes.addAlert(alert);
    const severe = alert.severity === 'P0' || alert.severity === 'P1' || /down|outage|unreachable|5xx|failed/i.test(alert.summary);
    if (severe) {
      this.deliverSpeech(`Excuse me, urgent alert: ${alert.severity} from ${alert.source}: ${alert.summary}`);
    }
  }
}

/** MeetingNotes — the single owner of meeting-summary state.
 *
 *  Extracted from the legacy cascade (one-brain consolidation): the summary
 *  used to live as private arrays inside SupportVoiceAgent, reachable only
 *  by keeping the whole cascade alive. Now any brain — the pipeline's
 *  stages, an alert feed, a host — feeds the same record, and finishMeeting
 *  emits the same MeetingSummaryData contract (persisted to KV when wired,
 *  never read aloud).
 */
import type {
  AlertSignal,
  ConcernItem,
  FeedbackItem,
  JiraChange,
  MeetingSummaryData,
  Utterance,
} from '../support-voice-agent/types.js';
import { renderMeetingSummary } from '../support-voice-agent/summary.js';
import type { KeyValueStore } from '../support-voice-agent/memory/store.js';

export interface MeetingNotesOptions {
  /** Optional durable KV: finished summaries persist under `summary:<startedAt>`. */
  kv?: KeyValueStore;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
}

export class MeetingNotes {
  private readonly conversation: Utterance[] = [];
  private readonly feedbackItems: FeedbackItem[] = [];
  private readonly concerns: ConcernItem[] = [];
  private readonly jiraChanges: JiraChange[] = [];
  private readonly alerts: AlertSignal[] = [];
  private readonly kv?: KeyValueStore;
  private readonly now: () => number;
  private spokenCount = 0;
  private startedAt: number;

  constructor(opts: MeetingNotesOptions = {}) {
    this.kv = opts.kv;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Record a participant utterance (drives the participants list). */
  recordUtterance(speakerId: string, text: string, ts = this.now()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.conversation.push({ speakerId, text: trimmed, ts });
  }

  addFeedback(item: FeedbackItem): void {
    this.feedbackItems.push(item);
  }

  addConcern(item: ConcernItem): void {
    this.concerns.push(item);
  }

  addAlert(alert: AlertSignal): void {
    this.alerts.push(alert);
  }

  /** Record a Jira mutation performed anywhere in the platform. */
  recordJiraChange(type: JiraChange['type'], issueKey: string, detail: string, at = this.now()): JiraChange {
    const change: JiraChange = { type, issueKey, detail, at };
    this.jiraChanges.push(change);
    return change;
  }

  /** Count a spoken response (hosts call this from their speech delivery). */
  countSpoken(n = 1): void {
    this.spokenCount += n;
  }

  /** End the meeting: build + emit the summary (never read aloud). */
  finishMeeting(opts?: { meetingId?: string; title?: string; startedAt?: number }): MeetingSummaryData {
    const now = this.now();
    const data: MeetingSummaryData = {
      meetingId: opts?.meetingId ?? `meeting-${now}`,
      title: opts?.title ?? 'Support standup',
      startedAt: opts?.startedAt ?? this.startedAt,
      endedAt: now,
      participants: [...new Set(this.conversation.map((u) => u.speakerId))],
      feedback: [...this.feedbackItems],
      concerns: [...this.concerns],
      jiraChanges: [...this.jiraChanges],
      alerts: [...this.alerts],
      spokenResponseCount: this.spokenCount,
    };
    if (this.kv) {
      void this.kv
        .set(`summary:${data.startedAt}`, JSON.stringify(data))
        .catch((err: Error) => console.error(`Summary persist failed: ${err.message}`));
    }
    return data;
  }

  /** Render the summary as text (Slack comment / Jira comment consumers). */
  static render(data: MeetingSummaryData): string {
    return renderMeetingSummary(data);
  }
}

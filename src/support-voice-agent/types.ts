/** Core domain types for the Support Voice Agent. */

/** How aggressively the agent may speak. See README for the full contract. */
export type AgentMode = 'silent' | 'response' | 'interrupt';

export type Severity = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/** A single transcribed utterance from a meeting participant. */
export interface Utterance {
  speakerId: string;
  text: string;
  /** Epoch ms. */
  ts: number;
}

/** A P0/P1-style alert ingested from Jira, CloudWatch, Splunk, etc. */
export interface AlertSignal {
  severity: Severity;
  /** e.g. 'jira', 'cloudwatch', 'splunk', 'meeting'. */
  source: string;
  summary: string;
  ticketKey?: string;
  /** Epoch ms. */
  ts: number;
}

/** Vocal feedback (e.g. "User hates the new UI") paraphrased and optionally filed as a Jira bug. */
export interface FeedbackItem {
  at: number;
  speakerId: string;
  original: string;
  paraphrase: string;
  /** Set when the feedback was filed as a Jira issue. */
  jiraKey?: string;
}

/** Vague technical complaints / background notes taken without speaking. */
export interface ConcernItem {
  at: number;
  speakerId: string;
  text: string;
}

/** A Jira mutation the agent performed (create / transition / comment). */
export interface JiraChange {
  type: 'created' | 'transitioned' | 'commented';
  issueKey: string;
  detail: string;
  /** Epoch ms. */
  at: number;
}

/** Payload emitted for every spoken response (wire this to TTS/audio). */
export interface SpeechEvent {
  text: string;
  urgent: boolean;
  /** Epoch ms. */
  timestamp: number;
}

/** Generated at the end of a meeting; posted to Slack/Jira, never read aloud. */
export interface MeetingSummaryData {
  meetingId: string;
  title: string;
  startedAt: number;
  endedAt: number;
  participants: string[];
  feedback: FeedbackItem[];
  concerns: ConcernItem[];
  jiraChanges: JiraChange[];
  alerts: AlertSignal[];
  spokenResponseCount: number;
}

/** Log query primitives shared by the log providers. */

export interface LogProvider {
  readonly name: string;
  query(query: LogQuery): Promise<LogQueryResult>;
}

export interface LogQueryResult {
  rows: LogRow[];
  provider: string;
  durationMs?: number;
  truncated?: boolean;
  error?: string;
}
export interface LogQuery {
  query: string;
  /** Epoch ms. */
  from?: number;
  /** Epoch ms. */
  to?: number;
  limit?: number;
  /** Provider-specific time strings (e.g. Splunk earliest_time). */
  earliest?: string;
  latest?: string;
}

export interface LogRow {
  /** Epoch ms. */
  ts?: number;
  message: string;
  fields?: Record<string, unknown>;
}

export interface LogQueryResult {
  rows: LogRow[];
  provider: string;
  durationMs?: number;
  truncated?: boolean;
  error?: string;
}
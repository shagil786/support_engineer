/** SupportVoiceAgent — the meeting-etiquette brain of the Support Voice Agent.
 *
 * Wires to the real world through ports:
 *  - input:  `processUtterance()` (transcripts) and `ingestAlert()` (P0/P1 signals)
 *  - output: the `speech` event (TTS / audio), `jira` event, `summary` event
 *  - adapters: `jira`, `logs`, `runbooks`, `slack` config options
 *
 * The actual microphone / wake-word / STT / meeting-join machinery lives in
 * the host (Freebuff Desktop); this class owns the conversation policy.
 */

import { TypedEmitter } from './events';
import * as h from './heuristics';
import type {
  AgentMode,
  AlertSignal,
  ConcernItem,
  FeedbackItem,
  JiraChange,
  MeetingSummaryData,
  Severity,
  SpeechEvent,
  Utterance,
} from './types';
import { JiraClient, formatJiraCreated, formatJiraUpdate } from './integrations/jira';
import type { RunbookAction, RunbookProvider } from './integrations/runbook';
import type { SlackNotifier } from './integrations/slack';
import type { LogProvider, LogQueryResult } from './integrations/logs';
import { renderMeetingSummary } from './summary';
import type { JiraConfig } from './integrations/jira';
import { LlmOrchestrator, DEFAULT_SYSTEM_PROMPT } from './tools/orchestrator';
import type { LlmClient } from './tools/llm';
import { Guardrails } from './guardrails';
import type { GuardrailsConfig } from './guardrails';

export interface SupportVoiceAgentConfig {
  mode?: AgentMode;
  wakeWord?: string;
  /** Minimum silence before queued speech is spoken (1.5 s default). */
  minPauseMs?: number;
  /** Hard cap on spoken responses unless reporting logs or critical data. */
  maxResponseWords?: number;
  /** How long "Agent, shut up" mutes the agent (5 min default). */
  muteDurationMs?: number;
  /** P0/P1 alerts still barge in while muted (safety override). */
  urgentBreaksMute?: boolean;
  /** How long a runbook offer stays valid (60 s default). */
  runbookConfirmWindowMs?: number;
  /** In silent mode, auto-file feedback bugs without speaking. */
  autoFileFeedback?: boolean;
  jira?: JiraConfig;
  logs?: LogProvider;
  runbooks?: RunbookProvider;
  slack?: SlackNotifier;
  /** Optional real LLM (Layer 2). When wired, direct status/data/help questions
   *  route through the LLM + tool orchestrator; everything else (wake word,
   *  mute, barge-in, confirmations) stays deterministic. */
  llm?: LlmClient;
  /** Layer 4 guardrails: RBAC + destructive-action approval + escalation. */
  guardrails?: GuardrailsConfig;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface AgentEvents {
  /** Every spoken line; wire to TTS/audio. `urgent` means barge-in was used. */
  speech: SpeechEvent;
  /** Every Jira mutation the agent performed. */
  jira: JiraChange;
  /** Every ingested alert. */
  alert: AlertSignal;
  /** Emitted when "Agent, shut up" mutes the agent. */
  muted: { until: number };
  /** End-of-meeting summary. */
  summary: MeetingSummaryData;
  /** Diagnostic log line. */
  log: { level: 'info' | 'warn' | 'error'; message: string };
  [k: string]: unknown;
}

/** Behavior defaults resolved; integration ports stay optional — an absent
 *  port means the agent is *unwired* for that backend and must degrade per
 *  spec ("I don't have that data in my current context…") instead of guessing
 *  a server. */
type ResolvedConfig = {
  mode: AgentMode;
  wakeWord: string;
  minPauseMs: number;
  maxResponseWords: number;
  muteDurationMs: number;
  urgentBreaksMute: boolean;
  runbookConfirmWindowMs: number;
  autoFileFeedback: boolean;
  now: () => number;
} & Pick<SupportVoiceAgentConfig, 'jira' | 'logs' | 'runbooks' | 'slack'>;

interface PendingBug {
  paraphrase: string;
  original: string;
  speakerId: string;
  at: number;
}

export class SupportVoiceAgent {
  mode: AgentMode;

  private readonly cfg: ResolvedConfig;
  private readonly emitter = new TypedEmitter<AgentEvents>();
  private jiraClient: JiraClient | undefined;
  private logProvider?: LogProvider;
  private runbookProvider?: RunbookProvider;
  private slackNotifier?: SlackNotifier;

  private readonly startedAt: number;
  private readonly conversation: Utterance[] = [];
  private readonly feedbackItems: FeedbackItem[] = [];
  private readonly concerns: ConcernItem[] = [];
  private readonly jiraChanges: JiraChange[] = [];
  private readonly alerts: AlertSignal[] = [];

  private pendingSpeech: Array<{ text: string; forceFull?: boolean }> = [];
  private mutedUntil = 0;
  private orchestrator?: LlmOrchestrator;
  readonly guardrails: Guardrails;
  private lastSpeaker?: string;
  private pendingRunbook: { actionId: string; at: number } | null = null;
  private pendingBug: PendingBug | null = null;
  private spokenCount = 0;

  constructor(config: SupportVoiceAgentConfig = {}) {
    this.cfg = {
      mode: config.mode ?? 'silent',
      wakeWord: config.wakeWord ?? h.DEFAULT_WAKE_WORD,
      minPauseMs: config.minPauseMs ?? h.DEFAULT_MIN_PAUSE_MS,
      maxResponseWords: config.maxResponseWords ?? h.DEFAULT_MAX_RESPONSE_WORDS,
      muteDurationMs: config.muteDurationMs ?? h.DEFAULT_MUTE_DURATION_MS,
      urgentBreaksMute: config.urgentBreaksMute ?? true,
      runbookConfirmWindowMs: config.runbookConfirmWindowMs ?? h.DEFAULT_RUNBOOK_CONFIRM_WINDOW_MS,
      autoFileFeedback: config.autoFileFeedback ?? false,
      // Integration ports are pass-through: no host, token, or project-key is
      // invented here. No jira config => the agent is Jira-unwired.
      jira: config.jira,
      logs: config.logs,
      runbooks: config.runbooks,
      slack: config.slack,
      now: config.now ?? Date.now,
    };
    this.mode = this.cfg.mode;
    this.startedAt = this.cfg.now();
    this.jiraClient = this.cfg.jira ? new JiraClient(this.cfg.jira) : undefined;
    this.logProvider = this.cfg.logs;
    this.runbookProvider = this.cfg.runbooks;
    this.slackNotifier = this.cfg.slack;
    this.guardrails = new Guardrails({ notifier: this.slackNotifier, ...config.guardrails });
    if (config.llm) {
      this.orchestrator = new LlmOrchestrator({
        llm: config.llm,
        deps: {
          jiraClient: this.jiraClient,
          logProvider: this.logProvider,
          runbookProvider: this.runbookProvider,
          slackNotifier: this.slackNotifier,
          speak: (text) => this.queueSpeech(text),
          guardrails: this.guardrails,
          currentSpeaker: () => this.lastSpeaker,
        },
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
      });
    }
  }

  /** True when an LLM is wired and the orchestrator can answer questions. */
  get hasLlm(): boolean {
    return this.orchestrator?.isWired() ?? false;
  }

  /* ------------------------------------------------------------- */
  /* Public API                                                     */
  /* ------------------------------------------------------------- */

  on<K extends keyof AgentEvents>(event: K, fn: (payload: AgentEvents[K]) => void): () => void {
    return this.emitter.on(event, fn);
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
    this.emitter.emit('log', { level: 'info', message: `Mode set to '${mode}'` });
  }

  getTranscript(): Utterance[] {
    return [...this.conversation];
  }

  /**
   * Feed a transcribed utterance (speakerId + text). Speech is queued and only
   * spoken after a pause (see onPause) — except urgent barge-ins, which speak
   * immediately.
   */
  processUtterance(speakerId: string, text: string, ts = this.cfg.now()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.conversation.push({ speakerId, text: trimmed, ts });
    this.lastSpeaker = speakerId;

    // 0. Prompt-injection guard (Layer 4): log, refuse, page security once.
    if (h.isPromptInjection(trimmed)) {
      this.log('warn', `Prompt-injection attempt from ${speakerId} refused: "${trimmed.slice(0, 80)}"`);
      void this.guardrails.pageSecurity(`Prompt-injection attempt in meeting by ${speakerId}: "${trimmed.slice(0, 200)}"`);
      this.queueSpeech("Sorry, I can't do that.");
      return;
    }

    // 1. "Agent, shut up" / "Stop talking" → mute until wake word (max 5 min).
    if (h.isShutUpCommand(trimmed)) {
      this.mutedUntil = ts + this.cfg.muteDurationMs;
      this.pendingSpeech = [];
      this.emitter.emit('muted', { until: this.mutedUntil });
      this.emitter.emit('log', { level: 'info', message: 'Muted until wake word or timeout' });
      return;
    }

    // 2. Wake word. Spec: after "shut up", only the wake word responds for the
    //    mute window — a bare wake word wakes the agent (greeting); a wake word
    //    wrapped around other content re-arms the agent but the muted utterance
    //    itself is not answered.
    const mutedBefore = this.mutedUntil > ts;
    const wake = h.containsWakeWord(trimmed, this.cfg.wakeWord);
    if (wake) this.mutedUntil = 0;

    // 3. "This is a P1" / "Critical incident" → barge in immediately
    //    (urgent signals break through the mute window).
    if (h.isCriticalDeclaration(trimmed)) {
      this.handleCriticalDeclaration(trimmed, speakerId, ts);
      return;
    }

    if (wake && mutedBefore) {
      if (h.isBareWakeWord(trimmed, this.cfg.wakeWord)) {
        this.queueSpeech("Yes, I'm here. What do you need?");
      }
      return;
    }

    const muted = this.mutedUntil > ts;

    // 4. Human confirms a pending runbook offer (within the confirm window;
    //    an expired offer is never executed).
    if (this.pendingRunbook && !muted) {
      if (ts - this.pendingRunbook.at > this.cfg.runbookConfirmWindowMs) {
        this.pendingRunbook = null;
        this.log('info', 'Runbook confirmation window expired — offer dropped without executing');
      } else if (h.isAffirmation(trimmed)) {
        const { actionId } = this.pendingRunbook;
        this.pendingRunbook = null;
        void this.confirmRunbook(actionId, speakerId);
        return;
      } else if (h.isNegation(trimmed)) {
        this.pendingRunbook = null;
        this.queueSpeech("Got it, I won't touch anything.");
        return;
      }
    }

    // 5. Human answers the "what priority?" question from a feedback offer.
    if (this.pendingBug && !muted) {
      if (h.isNegation(trimmed)) {
        const pending = this.pendingBug;
        this.pendingBug = null;
        this.feedbackItems.push({
          at: pending.at,
          speakerId: pending.speakerId,
          original: pending.original,
          paraphrase: pending.paraphrase,
        });
        this.queueSpeech("Got it, I won't file anything.");
        return;
      }
      const severity = h.parsePriority(trimmed);
      if (severity) {
        const pending = this.pendingBug;
        this.pendingBug = null;
        this.feedbackItems.push({
          at: pending.at,
          speakerId: pending.speakerId,
          original: pending.original,
          paraphrase: pending.paraphrase,
        });
        void this.fileBugFromFeedback(pending, severity);
        return;
      }
    }

    if (muted) return;

    // 6. Two humans deep in architecture → stay silent.
    if (h.isArchitectureDeepDive(this.conversation)) {
      return;
    }

    // 7. Verbal feedback → paraphrase + "Should I create a Jira bug? What priority?"
    if (h.isFeedback(trimmed)) {
      this.handleFeedback(trimmed, speakerId, ts);
      return;
    }

    // 8. Vague technical complaint → clarifying question (or background note in silent mode).
    if (h.isVagueTechnicalComplaint(trimmed)) {
      this.handleVagueComplaint(trimmed, speakerId, ts);
      return;
    }

    // 9. Direct question about status/data/help.
    if (h.isDirectQuestion(trimmed)) {
      if (this.hasLlm) {
        void this.routeToLlm(trimmed);
      } else {
        this.handleDirectQuestion(trimmed);
      }
      return;
    }

    // 10. Bare wake word with nothing else to answer → greeting.
    if (wake) {
      this.queueSpeech("Yes, I'm here. What do you need?");
    }
  }

  /** Meeting bridge calls this with the measured inter-utterance silence. */
  onPause(durationMs: number): void {
    if (durationMs >= this.cfg.minPauseMs) this.flushSpeech();
  }

  /** Speak any queued lines now (bridge detected turn-end). Returns how many were spoken. */
  flushSpeech(): number {
    const queued = this.pendingSpeech;
    this.pendingSpeech = [];
    for (const item of queued) this.speak(item.text, { forceFull: item.forceFull });
    return queued.length;
  }

  /** Ingest a P0/P1 alert (from Jira, CloudWatch, Splunk, an external monitor...). */
  ingestAlert(alert: AlertSignal): void {
    this.alerts.push(alert);
    this.emitter.emit('alert', alert);
    const severe = alert.severity === 'P0' || alert.severity === 'P1' || /down|outage|unreachable|5xx|failed/i.test(alert.summary);
    if (severe) {
      this.speak(
        `Excuse me, urgent alert: ${alert.severity} from ${alert.source}: ${alert.summary}`,
        { urgent: true, forceFull: true },
      );
    }
    if (this.jiraClient) {
      if (alert.ticketKey) {
        void this.jiraClient
          .addComment(alert.ticketKey, `Agent detected: ${alert.summary}`)
          .then(() => this.recordJira('commented', alert.ticketKey!, 'Alert noted'))
          .catch((err: Error) => {
            this.log('warn', `Alert comment failed: ${err.message}`);
            void this.guardrails.pageInfra(`Jira API failure adding alert comment (${err.message}) — agent failover engaged`);
          });
      } else {
        void this.jiraClient
          .createIssue({
            summary: `[${alert.severity}] ${alert.summary}`,
            description: `Source: ${alert.source}\nTriggered: ${new Date(alert.ts).toISOString()}`,
            priority: alert.severity,
            issueType: 'Incident',
          })
          .then((issue) => this.recordJira('created', issue.key, `Incident created from ${alert.severity} alert`))
          .catch((err: Error) => {
            this.log('warn', `Alert ticket creation failed: ${err.message}`);
            void this.guardrails.pageInfra(`Jira API failure creating alert ticket (${err.message}) — agent failover engaged`);
          });
      }
    }
  }

  /** Pull logs in the background and answer with a summarized verbal report. */
  async queryLogs(query: string, from?: number): Promise<LogQueryResult> {
    if (!this.logProvider) throw new Error('No log provider configured');
    return this.logProvider.query(h.buildLogQuery(query, from ?? this.cfg.now()));
  }

  /** Offer a runbook action, e.g. "Should I restart the pod?" — waits for confirmation. */
  async offerRunbookAction(actionId: string): Promise<void> {
    const action = await this.findRunbook(actionId);
    if (!action) {
      this.queueSpeech(`I couldn't find a runbook action called '${actionId}'.`);
      return;
    }
    this.pendingRunbook = { actionId, at: this.cfg.now() };
    this.queueSpeech(`Should I ${action.description}?`);
  }

  /** Provide a runbook provider at runtime (used by tests that wire runbooks after construction). */
  setRunbooks(runbooks: RunbookProvider): void {
    this.runbookProvider = runbooks;
  }

  /** Provide a Slack notifier at runtime (used by tests that wire Slack late). */
  setSlack(slack: SlackNotifier): void {
    this.slackNotifier = slack;
  }

  /** Move a ticket through a workflow transition; announces per the output rules. */
  async updateTicketStatus(issueKey: string, transitionName: string): Promise<void> {
    if (!this.jiraClient) {
      this.log('warn', 'Jira not configured');
      this.queueSpeech("I can't update Jira right now — it's not connected.");
      return;
    }
    await this.jiraClient.transition(issueKey, transitionName);
    this.recordJira('transitioned', issueKey, `Transitioned to '${transitionName}'`);
    this.queueSpeech(formatJiraUpdate({ issueKey, status: transitionName }));
  }

  /** Add a comment to a ticket (used for transcribed feedback). */
  async commentOnTicket(issueKey: string, comment: string): Promise<void> {
    if (!this.jiraClient) throw new Error('Jira not configured');
    await this.jiraClient.addComment(issueKey, comment);
    this.recordJira('commented', issueKey, 'Comment added');
    this.queueSpeech(formatJiraUpdate({ issueKey, comment }));
  }

  /** End the meeting: build + emit the summary (never read aloud). */
  finishMeeting(opts?: { meetingId?: string; title?: string; startedAt?: number }): MeetingSummaryData {
    const now = this.cfg.now();
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
    this.emitter.emit('summary', data);
    return data;
  }

  /** Post the meeting summary to Slack (channel) or Jira (issue comment). */
  async postMeetingSummary(
    target: { type: 'slack'; channel: string } | { type: 'jira'; issueKey: string },
    opts?: { meetingId?: string; title?: string },
  ): Promise<MeetingSummaryData> {
    const data = this.finishMeeting(opts);
    const text = renderMeetingSummary(data);
    if (target.type === 'slack') {
      if (!this.slackNotifier) throw new Error('Slack notifier not configured');
      await this.slackNotifier.postMessage(target.channel, text);
    } else if (this.jiraClient) {
      await this.jiraClient.addComment(target.issueKey, text);
      this.recordJira('commented', target.issueKey, 'Posted meeting summary');
    } else {
      throw new Error('Jira not configured');
    }
    return data;
  }

  /* ------------------------------------------------------------- */
  /* Internal handlers                                              */
  /* ------------------------------------------------------------- */

  private handleCriticalDeclaration(text: string, speakerId: string, ts: number): void {
    const severity: Severity = /\bp0\b/i.test(text) ? 'P0' : 'P1';
    const alert: AlertSignal = { severity, source: 'meeting', summary: text, ts };
    this.alerts.push(alert);
    this.emitter.emit('alert', alert);
    this.speak(`Excuse me, urgent alert: "${text}". Raising this as ${severity} now.`, {
      urgent: true,
      forceFull: true,
    });
    if (this.jiraClient) {
      void this.jiraClient
        .createIssue({
          summary: `[${severity}] ${text}`,
          description: `Spoken declaration during meeting by ${speakerId}.`,
          priority: severity,
          issueType: 'Incident',
        })
        .then((issue) => this.recordJira('created', issue.key, `Incident created from ${severity} declaration`))
        .catch((err: Error) => {
          this.log('warn', `Incident ticket creation failed: ${err.message}`);
          void this.guardrails.pageInfra(`Jira API incident creation failed (${err.message}) — agent failover engaged`);
        });
    }
  }

  private handleFeedback(text: string, speakerId: string, ts: number): void {
    const paraphrase = h.paraphraseFeedback(text);
    if (this.mode === 'silent') {
      // Background note only; no speech. Optionally file silently.
      if (this.cfg.autoFileFeedback && this.jiraClient) {
        void this.jiraClient
          .createIssue({
            summary: `[Feedback] ${paraphrase}`,
            description: `Original: "${text}"\nFrom: ${speakerId}`,
            priority: 'P3',
            issueType: 'Bug',
            labels: ['voice-feedback'],
          })
          .then((issue) => {
            this.recordJira('created', issue.key, 'Feedback filed (silent)');
            this.feedbackItems.push({ at: ts, speakerId, original: text, paraphrase, jiraKey: issue.key });
          })
          .catch((err: Error) => {
          this.log('warn', `Silent feedback filing failed: ${err.message}`);
          void this.guardrails.pageInfra(`Jira API filing silent feedback failed (${err.message}) — agent failover engaged`);
        });
        return;
      }
      this.feedbackItems.push({ at: ts, speakerId, original: text, paraphrase });
      this.emitter.emit('log', { level: 'info', message: `Silent mode: feedback noted — "${paraphrase}"` });
      return;
    }
    // Response / interrupt mode: paraphrase + ask about the bug.
    this.pendingBug = { paraphrase, original: text, speakerId, at: ts };
    this.queueSpeech(`Got it — "${paraphrase}" Should I create a Jira bug for this? What priority?`);
  }

  private handleVagueComplaint(text: string, speakerId: string, ts: number): void {
    this.concerns.push({ at: ts, speakerId, text });
    if (this.mode === 'silent') {
      this.emitter.emit('log', { level: 'info', message: `Silent mode: complaint noted — "${text}"` });
      return;
    }
    this.queueSpeech("Sounds like something's off. Which service, and what error are you seeing?");
  }

  private handleDirectQuestion(text: string): void {
    // In silent mode the agent only answers when addressed directly.
    const mentionsAgent = h.mentionsAgent(text);
    if (this.mode === 'silent' && !mentionsAgent) {
      this.emitter.emit('log', { level: 'info', message: 'Silent mode: group question logged, no speech' });
      return;
    }

    // Ticket status question.
    const ticket = h.extractTicketKey(text);
    if (ticket && this.jiraClient) {
      this.queueSpeech(`Checking ${ticket} now.`);
      void this.jiraClient
        .getIssue(ticket)
        .then((issue) => this.speak(`${ticket} is currently '${issue.status}'.`))
        .catch((err: Error) => {
          this.log('warn', `Jira getIssue failed: ${err.message}`);
          this.jiraFailover(`pull ${ticket}`);
        });
      return;
    }

    // Log question.
    if (h.asksForLogs(text) && this.logProvider) {
      this.queueSpeech('Pulling that now.');
      void this.logProvider
        .query(h.buildLogQuery(text, this.cfg.now()))
        .then((result) => this.speak(`Here's what I'm seeing: ${this.summarizeLogs(result)}`, { forceFull: true }))
        .catch((err: Error) => {
          this.log('warn', `Log query failed: ${err.message}`);
          this.queueSpeech(`The log service is inaccessible — I couldn't run that query. I will retry shortly. I have also alerted the infrastructure team via Slack.`, { forceFull: true });
          void this.guardrails.pageInfra(`Log provider failure (${err.message}) — agent failover engaged`);
        });
      return;
    }

    // No data locally → honest fallback.
    this.queueSpeech("I don't have that data in my current context, but I can pull it from Jira now.");
  }

  private async fileBugFromFeedback(pending: PendingBug, severity: Severity): Promise<void> {
    if (!this.jiraClient) {
      // Jira-unwired: keep the feedback for the summary, say so honestly.
      this.log('warn', 'Feedback confirmed but Jira is not connected — kept for summary only');
      this.queueSpeech("I've noted that down, but I'm not connected to Jira right now, so I can't file it.");
      return;
    }
    try {
      const issue = await this.jiraClient.createIssue({
        summary: `[Feedback] ${pending.paraphrase}`,
        description: `Original: "${pending.original}"\nFrom: ${pending.speakerId}\nPriority per requester: ${severity}`,
        priority: severity,
        issueType: 'Bug',
        labels: ['voice-feedback'],
      });
      this.recordJira('created', issue.key, `Bug filed from vocal feedback (${severity})`);
      const item = this.feedbackItems.find((f) => f.at === pending.at && f.speakerId === pending.speakerId);
      if (item) {
        item.jiraKey = issue.key;
      }
      this.speak(formatJiraCreated({ issueKey: issue.key, priority: severity, comment: pending.paraphrase }), {});
    } catch (err) {
      this.log('warn', `Bug filing failed: ${(err as Error).message}`);
      this.jiraFailover('file that bug');
    }
  }

  /** Human said yes to a runbook offer. Destructive actions additionally
   *  require the confirming speaker to hold an approver role (Layer 4 RBAC). */
  private async confirmRunbook(actionId: string, speakerId: string): Promise<void> {
    const action = await this.findRunbook(actionId);
    if (action?.destructive && !this.guardrails.isApprover(speakerId)) {
      this.queueSpeech("I need an admin to approve that — it's destructive. Paging one now.");
      void this.guardrails.pageSecurity(`Destructive action '${actionId}' awaiting admin approval (requested by ${speakerId})`);
      return;
    }
    void this.executeRunbook(actionId);
  }

  private async executeRunbook(actionId: string): Promise<void> {
    if (!this.runbookProvider) return;
    this.speak('On it.', {});
    try {
      const result = await this.runbookProvider.run(actionId);
      this.speak(result.ok ? `Done — ${result.output ?? 'runbook completed.'}` : `That didn't fully work: ${result.error ?? 'unknown error'}`, {});
    } catch (err) {
      this.log('warn', `Runbook execution failed: ${(err as Error).message}`);
      this.speak(`I hit an error running that: ${(err as Error).message}`, {});
    }
  }

  private async findRunbook(actionId: string): Promise<RunbookAction | undefined> {
    if (!this.runbookProvider) return undefined;
    try {
      const list = this.runbookProvider.list();
      if (list instanceof Promise) {
        const actions = await list;
        return actions.find((a) => a.id === actionId);
      }
      return list.find((a) => a.id === actionId);
    } catch (err) {
      this.log('warn', `Runbook list failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /* ------------------------------------------------------------- */
  /* Speech plumbing                                                */
  /* ------------------------------------------------------------- */

  private speak(text: string, opts: { urgent?: boolean; forceFull?: boolean } = {}): void {
    const now = this.cfg.now();
    if (this.mutedUntil > now && !(this.cfg.urgentBreaksMute && opts.urgent)) return;
    const limited = opts.forceFull || opts.urgent ? text : h.enforceMaxWords(text, this.cfg.maxResponseWords);
    this.spokenCount++;
    this.emitter.emit('speech', { text: limited, urgent: opts.urgent ?? false, timestamp: now });
  }

  /** Route a direct question through the LLM + tool loop. Speech goes
   *  through the normal queue so the pause gate and word cap still apply.
   *  On any LLM failure or unwired result, degrade to the deterministic
   *  handler — the meeting never hangs on the model. */
  private async routeToLlm(text: string): Promise<void> {
    const orch = this.orchestrator;
    if (!orch) {
      this.handleDirectQuestion(text);
      return;
    }
    const history = this.conversation
      .slice(-8, -1)
      .map((u) => ({ role: 'user' as const, content: `${u.speakerId}: ${u.text}` }));
    const before = this.spokenCount;
    const result = await orch.process(text, history);
    if (result.fallbackToDeterministic) {
      this.log('warn', `LLM fallback to deterministic answer: ${result.error ?? 'unwired'}`);
      this.handleDirectQuestion(text);
      return;
    }
    if (result.speech) this.queueSpeech(result.speech);
    else if (this.spokenCount === before && result.toolResults.length === 0) {
      this.handleDirectQuestion(text);
    }
  }

  /** Spec failover: name the failed backend, promise re-sync, alert infra. */
  private jiraFailover(action: string): void {
    this.queueSpeech(`Jira is inaccessible — I couldn't ${action}. I will update it when I reconnect. I have also alerted the infrastructure team via Slack.`, { forceFull: true });
    void this.guardrails.pageInfra(`Jira API failure during '${action}' — agent failover engaged`);
  }

  private queueSpeech(text: string, opts: { forceFull?: boolean } = {}): void {
    if (this.mutedUntil > this.cfg.now()) return;
    this.pendingSpeech.push({ text, forceFull: opts.forceFull });
  }

  private summarizeLogs(result: LogQueryResult & { rows: Array<{ message: string }> }): string {
    const tops = result.rows
      .slice(0, 5)
      .map((r: { message: string }) => r.message.replace(/\s+/g, ' ').slice(0, 140))
      .join('; ');
    const base = `${result.provider}: ${result.rows.length} matching event(s)`;
    if (result.error) return `${base} (query issue: ${result.error})`;
    return tops ? `${base}. Top: ${tops}` : `${base}.`;
  }

  private recordJira(type: JiraChange['type'], issueKey: string, detail: string): void {
    const change: JiraChange = { type, issueKey, detail, at: this.cfg.now() };
    this.jiraChanges.push(change);
    this.emitter.emit('jira', change);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emitter.emit('log', { level, message });
  }
}

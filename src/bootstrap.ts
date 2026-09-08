/**
 * createPlatform — the production composition root (spec §3).
 *
 * Wires all five layers plus the legacy agent into one running platform:
 * Understanding → Governance → Execution over the shared DecisionEvent log,
 * with the Learning layer optionally scheduled and its durable
 * ProcedureLibrary handed to the Supervisor. Everything degrades honestly:
 * an empty options object yields a fully legal platform (deterministic
 * classifier, in-memory cross scope, console approval channel) with no
 * integrations wired.
 *
 * Security defaults: the SafetyNet speaker registry treats unknown speakers
 * as `guest` (least privilege — RBAC vetoes destructive tools for them);
 * only the ApprovalGate's own `approver` identity is trusted as `admin`
 * unless the host supplies a real `speakerRole` resolver.
 */
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JsonlFileEventLog } from './event-log/log.js';
import { LegacyClassifierAdapter } from './understanding/legacy/classifier-adapter.js';
import { IntentClassifier } from './understanding/intent-classifier.js';
import { EpisodicMemory } from './understanding/memory/episodic.js';
import { ContextAssembler } from './understanding/context-assembler.js';
import { FileBackedKnowledgeBase } from './understanding/knowledge/knowledge-base.js';
import { embedderFromConfig, type EmbeddingsConfig } from './understanding/memory/embedders/factory.js';
import { GroundedAnswerer } from './understanding/grounded-answerer.js';
import { LlmClaimJudge } from './understanding/faithfulness-eval.js';
import { PolicyEngine } from './governance/policy-engine.js';
import { SafetyNet } from './governance/safety-net/index.js';
import type { SpeakerRole } from './governance/safety-net/index.js';
import { ApprovalGate, type SlackLike } from './governance/approval-gate.js';
import { SupervisorAgent } from './execution/supervisor.js';
import { ToolRunner } from './execution/tool-runner.js';
import { TriageAgent } from './execution/agents/triage.js';
import { InvestigatorAgent } from './execution/agents/investigator.js';
import { ExecutorAgent } from './execution/agents/executor.js';
import { ReviewerAgent } from './execution/agents/reviewer.js';
import { OutcomeRecorder } from './learning/outcome-recorder.js';
import { LearningLoop } from './learning/learning-loop.js';
import { ProcedureLibrary } from './execution/procedure-library.js';
import { OrchestratedPipeline } from './pipeline/agent-pipeline.js';
import { SupportVoiceAgent } from './support-voice-agent/agent.js';
import { SlackBotClient } from './support-voice-agent/integrations/slack-bot.js';
import { InMemoryRunbookProvider } from './support-voice-agent/integrations/runbook.js';
import { JiraClient } from './support-voice-agent/integrations/jira.js';
import type { JiraConfig } from './support-voice-agent/integrations/jira.js';
import type { LogProvider } from './support-voice-agent/types.js';
import type { SlackNotifier } from './support-voice-agent/integrations/slack.js';
import type { RunbookAction } from './support-voice-agent/integrations/runbook.js';
import type { LlmConfig } from './support-voice-agent/tools/llm.js';
import { OpenAiCompatibleClient } from './support-voice-agent/tools/llm.js';

/** Last-resort approval channel: posts to stderr so approvals are visible
 *  in process logs even with no Slack wired. Real deployments inject a
 *  SlackNotifier. */
const consoleSlack: SlackLike = {
  async postMessage(channel, text) {
    console.error(`[approval:${channel}] ${text}`);
  },
};

export interface PlatformOptions {
  /** Root for runtime data: <dataDir>/{events,outcomes,memory,stats}. */
  dataDir: string;
  /** Learning loop opt-in (off by default). When enabled, the cross-scope
   *  episodic memory is durable and the ProcedureLibrary is scheduled. */
  learning?: { enabled: boolean; intervalMs?: number };
  /** Integration ports (all optional; unwired = honest degradation). */
  jira?: JiraConfig;
  logProvider?: LogProvider;
  slack?: SlackNotifier;
  /** Runbook catalog; defaults to an empty (no-op) provider. */
  runbooks?: RunbookAction[];
  llm?: LlmConfig;
  /** Policy bundle path; defaults to ./policies/default.yaml. */
  policyPath?: string;
  /** Approval Slack channel; defaults to #support-agent-approvals. */
  approvalChannel?: string;
  /** Bot user token (xoxb-…) enabling the emoji-reaction approval UX: the
   *  gate posts via chat.postMessage (resolving message refs so reactions
   *  correlate to the right approval) instead of the fire-and-forget webhook. */
  slackBotToken?: string;
  /** Approval pending window (default: the gate's 5 minutes); overrides via
   *  APPROVAL_TIMEOUT_MS (>= 1000) in env-wired hosts. */
  approvalTimeoutMs?: number;
  /** Embedding backend for the knowledge base (absent = built-in hash
   *  embedder). Provided by configFromEnv as `embeddings` in env-wired hosts. */
  embeddings?: EmbeddingsConfig;
  /** Supervisor caps (absent keys = the supervisor's built-in defaults).
   *  Provided by configFromEnv as `supervisorCaps` in env-wired hosts. */
  supervisorCaps?: {
    maxHops?: number;
    maxTokens?: number;
    maxWallClockMs?: number;
    maxIdenticalToolCalls?: number;
  };
  /** SafetyNet speaker registry. Default: unknown = guest, 'approver' = admin. */
  speakerRole?: (speakerId: string) => 'admin' | 'engineer' | 'viewer' | 'guest' | undefined;
  /** Where pipeline speech is delivered (TTS bridge / console). The optional
   *  second argument is the Slack thread to reply in when the utterance came
   *  from one; hosts that ignore it keep the bare-text shape. */
  deliverSpeech?: (text: string, target?: { channel: string; threadTs: string }) => void;
  /** Injectable Slack client for thread replies (answer-back). Satisfied by
   *  SlackBotClient in production; tests may inject a fake. When absent,
   *  thread answers degrade to the plain deliverSpeech path. */
  slackBot?: import('./governance/approval-gate.js').SlackLike;
  now?: () => number;
}

export interface Platform {
  legacy: SupportVoiceAgent;
  pipeline: OrchestratedPipeline;
  eventLog: JsonlFileEventLog;
  /** Present only when learning is enabled. */
  learningLoop?: LearningLoop;
  /** Always present and wired into the supervisor; matches previously-
   *  learned procedures even when the learning loop is off. */
  library: ProcedureLibrary;
  /** Hybrid knowledge base (BM25+vector, durable snapshot). Ingest docs via
   *  `ingestDoc()`; retrieval is wired into the ContextAssembler. */
  knowledge: FileBackedKnowledgeBase;
  /** Grounded answering over the knowledge base: refuses when retrieval is
   *  empty, cites [n] sources otherwise, extractive fallback without an LLM. */
  answerer: GroundedAnswerer;
  /** Safe to call always; stops the scheduled loop when one exists. */
  stopLearning(): void;
  /** Resolves when boot-time async work has settled (KB vector indexing,
   *  durable-store compatibility self-check) and reports the state a
   *  readiness surface should expose. */
  ready(): Promise<{
    learning: 'on' | 'off';
    procedures: number;
    kb: { docs: number };
  }>;
  /** The ApprovalGate: hosts with a Slack Events endpoint route
   *  reaction_added events here (gate.handleReaction) for emoji sign-off. */
  approvals: ApprovalGate;
  /** Resolves a Slack user id to a platform role for reaction sign-off.
   *  Falls back to the SafetyNet speaker resolver (unknown = guest). */
  speakerRole(id: string): SpeakerRole | undefined;
}

export function createPlatform(opts: PlatformOptions): Platform {
  const dataDir = resolve(opts.dataDir);
  const eventsDir = join(dataDir, 'events');
  const outcomesDir = join(dataDir, 'outcomes');
  const crossPath = join(dataDir, 'memory', 'procedures.json');
  const statsPath = join(dataDir, 'stats', 'procedure-stats.json');
  const learningEnabled = opts.learning?.enabled === true;
  const learningIntervalRaw = opts.learning?.intervalMs ?? 15 * 60_000;
  const learningIntervalMs = Number.isFinite(learningIntervalRaw) && learningIntervalRaw >= 1000 ? learningIntervalRaw : 15 * 60_000;
  const now = opts.now;

  const eventLog = new JsonlFileEventLog({ baseDir: eventsDir });
  // Observability: every LLM completion (client-side, cross-layer) lands in
  // the event spine as llm_call — model/latency/attempts/usage, never
  // prompt or response content. correlationId is synthetic: a completion is
  // not always request-scoped inside the client.
  const llmCallEvent = async (info: {
    model: string;
    latencyMs: number;
    attempts: number;
    ok: boolean;
    errorCode?: string;
    promptTokens?: number;
    completionTokens?: number;
  }): Promise<void> => {
    try {
      await eventLog.append({
        correlationId: `llm:${Date.now()}`,
        ts: Date.now(),
        layer: 'understanding',
        source: 'internal',
        kind: 'llm_call',
        ...info,
      });
    } catch {
      // Telemetry must never break inference.
    }
  };
  const llm = opts.llm
    ? new OpenAiCompatibleClient({ ...opts.llm, onCall: (info) => void llmCallEvent(info) })
    : new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });

  // Learning first: it owns the shared (durable) episodic memory that the
  // ContextAssembler also reads, and its library feeds the supervisor. The
  // cross scope is ALWAYS durable — with learning off nothing writes to it,
  // but previously-learned procedures still serve (library without loop is
  // a supported mode: "serve what was learned, stop learning").
  let learningLoop: LearningLoop | undefined;
  // Per-meeting scope is durable too (spec §4.1): meeting context survives
  // restarts, TTL expiry (30d default) and purgeMeeting() persist like any
  // other mutation.
  const episodic = new EpisodicMemory({
    crossPath,
    perMeetingPath: join(dataDir, 'memory', 'meetings.json'),
    ...(now ? { now } : {}),
  });
  if (learningEnabled) {
    learningLoop = new LearningLoop({
      eventLog,
      outcomesDir,
      crossPath,
      statsPath,
      episodic,
      ...(now ? { now } : {}),
    });
    // Schedule the loop — construction alone was a silent no-op: the serve
    // banner said "learning: on, every Nms" while no interval ever fired.
    // Manual ticks (console :learning tick) always worked; this makes the
    // scheduled loop real. Tests can drive ticks explicitly instead.
    learningLoop.start(learningIntervalMs);
  }
  const library = new ProcedureLibrary({ episodic });

  const classifier = new IntentClassifier({
    llm,
    fallback: new LegacyClassifierAdapter(),
    eventLog,
    ...(now ? { now } : {}),
  });
  // Durable hybrid knowledge base: runbooks/incidents/postmortems ingested by
  // the host (or the demo seed) become retrievable context with provenance.
  // The configured embedder (remote OpenAI-compatible OR local in-process,
  // via the shared factory) replaces the hash backend; vectors already
  // persisted under the old backend need a one-time `knowledge.reindex()`.
  const embedder = embedderFromConfig(opts.embeddings);
  const knowledge = new FileBackedKnowledgeBase({
    path: join(dataDir, 'knowledge', 'kb.json'),
    ...(embedder ? { embedder } : {}),
  });
  const assembler = new ContextAssembler({ episodic, knowledge });

  const policyYaml = readFileSync(opts.policyPath ?? resolve(process.cwd(), 'policies/default.yaml'), 'utf8');
  const policyEngine = new PolicyEngine({ yaml: policyYaml });
  // The gate-minted 'approver' identity is ALWAYS trusted as admin — it only
  // exists after M-of-N human approval, so it is not client-assertable. Host
  // resolvers handle everyone else; replacing (not composing) the approver
  // mapping would make every approved execution fail the SafetyNet re-check.
  const speakerRole = (id: string) => (id === 'approver' ? ('admin' as const) : opts.speakerRole?.(id));
  const safetyNet = new SafetyNet({ speakers: speakerRole });
  // With a bot token, approvals post via chat.postMessage (message refs let
  // reactions correlate to the right approval); otherwise the fire-and-forget
  // webhook / console fallback posts as before.
  const approvalSlack = opts.slackBotToken
    ? new SlackBotClient({ botToken: opts.slackBotToken })
    : (opts.slack ?? consoleSlack);
  const approvals = new ApprovalGate({
    slack: approvalSlack,
    securityChannel: opts.approvalChannel ?? '#support-agent-approvals',
    approverCount: 2,
    ...(opts.approvalTimeoutMs !== undefined ? { defaultTimeoutMs: opts.approvalTimeoutMs } : {}),
    eventLog,
    ...(now ? { now } : {}),
  });

  const runbookProvider = new InMemoryRunbookProvider(opts.runbooks ?? []);
  // Speech: the pipeline's deliverSpeech is the voice; meeting_interrupt (P0/P1
  // alerts) speaks through the same channel via the ToolRunner context. When a
  // Slack bot is wired, deliverSpeech ALSO replies in-thread — the answer lands
  // where the question was asked, not just on the console.
  const slackBot = opts.slackBot ?? (opts.slackBotToken ? new SlackBotClient({ botToken: opts.slackBotToken }) : undefined);
  const toolRunner = new ToolRunner({
    context: {
      ...(opts.jira ? { jiraClient: new JiraClient(opts.jira) } : {}),
      ...(opts.logProvider ? { logProvider: opts.logProvider } : {}),
      ...(opts.slack ? { slackNotifier: opts.slack } : {}),
      runbookProvider,
      ...(opts.deliverSpeech ? { speak: (text: string) => opts.deliverSpeech!(text) } : {}),
    },
    safetyNet,
    eventLog,
  });
  const supervisor = new SupervisorAgent({
    triage: new TriageAgent({ llm }),
    investigator: new InvestigatorAgent({ llm }),
    executor: new ExecutorAgent({ llm }),
    reviewer: new ReviewerAgent({ llm }),
    toolRunner,
    eventLog,
    ...opts.supervisorCaps,
    ...(library ? { procedures: library } : {}),
    ...(now ? { now } : {}),
  });

  const legacy = new SupportVoiceAgent({
    mode: 'interrupt',
    runbooks: runbookProvider,
    ...(opts.logProvider ? { logs: opts.logProvider } : {}),
    ...(opts.jira ? { jira: opts.jira } : {}),
    ...(opts.slack ? { slack: opts.slack } : {}),
  });

  // The claim-verification guard rides along whenever the LLM is wired: any
  // unsupported claim in an LLM answer drops it to the extractive floor, so
  // hallucination prevention happens in the request path, not just in eval.
  const answerer = new GroundedAnswerer({
    knowledge,
    llm,
    ...(llm.isWired() ? { claimJudge: new LlmClaimJudge(llm) } : {}),
  });
  const pipeline = new OrchestratedPipeline({
    legacy,
    classifier,
    assembler,
    policyEngine,
    safetyNet,
    approvals,
    supervisor,
    toolRunner,
    eventLog,
    episodic,
    outcomeRecorder: new OutcomeRecorder({ eventLog, outcomesDir, ...(now ? { now } : {}) }),
    runbookProvider,
    ...(opts.deliverSpeech
      ? {
          deliverSpeech: (text: string, target?: { channel: string; threadTs: string }) => {
            opts.deliverSpeech!(text, target);
            if (target && slackBot?.postReply) void slackBot.postReply(target.channel, target.threadTs, text).catch(() => {});
          },
        }
      : {}),
    answerer,
    ...(now ? { now } : {}),
  });

  return {
    legacy,
    pipeline,
    eventLog,
    learningLoop,
    library,
    knowledge,
    answerer,
    approvals,
    speakerRole,
    stopLearning() {
      learningLoop?.stop();
    },
    async ready() {
      // Boot async work: the KB re-embeds vectors and indexes on construction;
      // the durable episodic store runs its compatibility self-check. Both are
      // fire-and-forget internally — /readyz waits for them so a load balancer
      // never routes traffic into a half-warmed agent.
      await Promise.all([knowledge.whenIndexed(), episodic.whenBootChecked()]);
      return {
        learning: learningLoop ? ('on' as const) : ('off' as const),
        procedures: library.size(),
        kb: { docs: knowledge.stats().docs },
      };
    },
  };
}

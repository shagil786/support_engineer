/**
 * OrchestratedPipeline (spec §3) — wires the five layers around the live
 * SupportVoiceAgent by COMPOSITION, not modification:
 *
 *  - The legacy agent keeps its untouched etiquette cascade (mute/wake/
 *    confirmations/priority prompts) and its event emitter. The wrapper
 *    never duplicates that logic; it asks the agent for it.
 *  - Etiquette intents (mute, wake, critical, complaint, feedback-ack
 *    flows) go straight to the legacy cascade — the pipeline does not
 *    intercept what works.
 *  - Content intents (question, runbook_offer) flow through Understanding
 *    → Governance → Execution, each step emitting DecisionEvents under a
 *    per-utterance correlationId.
 *  - ANY pipeline failure (LLM transport, store, gate) degrades to the
 *    legacy cascade — the meeting never hangs on the platform.
 *
 * Surface envelopes (Jira/Slack/cron webhooks, proactive anomalies) enter
 * through processEnvelope() with the same governance guarantees.
 */
import { correlationId } from '../event-log/correlation.js';
import type { DecisionEvent, IntentEnvelope } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import type { ToolName, ToolResult } from '../support-voice-agent/tools/types.js';
import type { SupportVoiceAgent } from '../support-voice-agent/agent.js';
import type { RunbookProvider } from '../support-voice-agent/integrations/runbook.js';
import { GroundedAnswerer } from '../understanding/grounded-answerer.js';
import type { IntentClassifier } from '../understanding/intent-classifier.js';
import type { ContextAssembler } from '../understanding/context-assembler.js';
import type { PolicyEngine } from '../governance/policy-engine.js';
import type { SafetyNet } from '../governance/safety-net/index.js';
import { ApprovalGate, type ApprovalSnapshot } from '../governance/approval-gate.js';
import type { SupervisorAgent } from '../execution/supervisor.js';
import type { ToolRunner } from '../execution/tool-runner.js';
import type { OutcomeRecorder } from '../learning/outcome-recorder.js';

export interface PipelineRouting {
  routed: 'pipeline' | 'legacy';
  correlationId: string;
  ok?: boolean;
  reason?: string;
  approvalId?: string;
  approvalStatus?: ApprovalSnapshot['status'];
  /** Present on legacy fallback: the wrapper re-dispatched into the cascade. */
  legacyFallback?: boolean;
  /** Grounded-answer fields: present when a question was answered from the
   *  knowledge base ('knowledge') or, on KB refusal, from governed log
   *  query results ('logs'). Absent for legacy/etiquette routes and when no
   *  answerer is wired. */
  answer?: string;
  answerSource?: 'knowledge' | 'logs';
}

export interface ApprovedAction {
  approvalId: string;
  correlationId: string;
  action: { tool: ToolName; args: Record<string, unknown> };
  decision: import('../governance/decision.js').Decision;
}

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
  deliverSpeech?: (text: string) => void;
  /** Grounded answerer over the knowledge base. When wired, question intents
   *  are answered KB-first (cited speech, no tools); KB refusals fall through
   *  to the governed log-query path. Unwired → questions go straight to the
   *  governed path (previous behavior). */
  answerer?: GroundedAnswerer;
  now?: () => number;
}

const ETIQUETTE_SUBKINDS = new Set(['mute', 'wake', 'critical', 'complaint', 'feedback']);

export class OrchestratedPipeline {
  private readonly legacy: SupportVoiceAgent;
  private readonly classifier: IntentClassifier;
  private readonly assembler: ContextAssembler;
  private readonly policyEngine: PolicyEngine;
  private readonly safetyNet: SafetyNet;
  private readonly approvals: ApprovalGate;
  private readonly supervisor: SupervisorAgent;
  private readonly toolRunner: ToolRunner;
  private readonly eventLog: EventLog;
  private readonly outcomeRecorder?: OutcomeRecorder;
  private readonly runbookProvider?: RunbookProvider;
  private readonly deliverSpeech: (text: string) => void;
  private readonly answerer?: GroundedAnswerer;
  private readonly now: () => number;
  /** approvalId → staged action awaiting (or holding) a grant. */
  private readonly staged = new Map<string, ApprovedAction>();

  constructor(opts: OrchestratedPipelineOptions) {
    this.legacy = opts.legacy;
    this.classifier = opts.classifier;
    this.assembler = opts.assembler;
    this.policyEngine = opts.policyEngine;
    this.safetyNet = opts.safetyNet;
    this.approvals = opts.approvals;
    this.supervisor = opts.supervisor;
    this.toolRunner = opts.toolRunner;
    this.eventLog = opts.eventLog;
    this.outcomeRecorder = opts.outcomeRecorder;
    this.runbookProvider = opts.runbookProvider;
    this.deliverSpeech = opts.deliverSpeech ?? ((t) => void t);
    this.answerer = opts.answerer;
    this.now = opts.now ?? Date.now;
  }

  /** Entry point for live meeting utterances. */
  async processUtterance(speakerId: string, text: string, ts = this.now()): Promise<PipelineRouting> {
    const cid = correlationId(ts);
    try {
      const envelope = await this.classifier.classify(
        { text, source: 'meeting', ts, speakerId },
        { correlationId: cid },
      );

      // Etiquette intents belong to the legacy cascade, always — and so does
      // unrecognized chatter (the cascade's greeting/ignore policy owns it).
      const isEtiquette =
        envelope.intent.kind === 'meeting_response' && ETIQUETTE_SUBKINDS.has(envelope.intent.subKind);
      if (isEtiquette || envelope.intent.kind === 'unknown') {
        this.legacy.processUtterance(speakerId, text, ts);
        return { routed: 'legacy', correlationId: cid, legacyFallback: false };
      }

      return await this.dispatch(cid, envelope, { correlationId: cid, speakerId, text });
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
    const staged = this.staged.get(approvalId);
    if (!staged) return { routed: 'pipeline', correlationId, ok: false, reason: `unknown approvalId: ${approvalId}` };
    const snap = this.approvals.status(approvalId);
    if (snap?.status !== 'granted') {
      return { routed: 'pipeline', correlationId, ok: false, reason: `approval not granted (status: ${snap?.status ?? 'unknown'})` };
    }
    return this.runGoverned(staged.correlationId, staged.action, staged.decision);
  }

  /* ------------------------- internals ------------------------- */

  private async dispatch(
    cid: string,
    envelope: IntentEnvelope,
    ctx: { correlationId: string; speakerId: string; text: string },
  ): Promise<PipelineRouting> {
    const bundle = await this.assembler.assemble({ envelope, recent: await this.recentEvents() });

    const subKind = envelope.intent.kind === 'meeting_response' ? envelope.intent.subKind : undefined;

    // Runbook offers resolve to a concrete provider action; the provider's
    // destructive flag (not the text) drives policy.
    if (subKind === 'runbook_offer') {
      return this.handleRunbookOffer(cid, envelope, ctx);
    }

    // KB-first for questions: when the knowledge base can ground an answer
    // (stricter 0.4 floor — spoken answers must be genuinely about the
    // corpus, not trigram-adjacent), speak it with citations — no tool call,
    // no LLM dance. A refusal falls through to the governed log-query path
    // below, so live-data questions still work exactly as before.
    let kbRefused = false;
    // Live-data questions never touch the static KB: a lexically-similar
    // chunk would otherwise answer "are there fresh errors right now?" from
    // a postmortem. The classifier flags these (intent.liveData); absent
    // flag (legacy/heuristic envelopes) keeps KB-first unchanged.
    const liveData = envelope.intent.kind === 'meeting_response' && envelope.intent.subKind === 'question' && envelope.intent.liveData === true;
    // A skipped KB is a KB that did not answer — same 'logs' provenance.
    if (liveData) kbRefused = true;
    if (subKind === 'question' && this.answerer && !liveData) {
      const grounded = await this.answerer.answer(ctx.text, { topK: 4, minScore: 0.4 });
      if (!grounded.refused) {
        this.deliverSpeech(grounded.answer);
        await this.eventLog.append({
          correlationId: cid,
          ts: this.now(),
          layer: 'understanding',
          source: 'internal',
          kind: 'grounded_answer',
          question: ctx.text,
          answer: grounded.answer,
          citations: grounded.citations,
          sources: grounded.sources,
          refused: false,
          usedLlm: grounded.usedLlm,
        });
        return {
          routed: 'pipeline',
          correlationId: cid,
          ok: true,
          answer: grounded.answer,
          answerSource: 'knowledge',
        };
      }
      kbRefused = true;
    }

    // Questions propose a read-only log query (the only registry tool that
    // answers a status question directly).
    const proposal: { tool: ToolName; args: Record<string, unknown> } =
      subKind === 'question'
        ? { tool: 'query_logs', args: { query_string: this.queryFrom(envelope) } }
        : { tool: 'meeting_interrupt', args: { message: this.summaryOf(envelope) } };

    // Governance.
    const decision = this.policyEngine.evaluate(envelope, proposal);
    const safety = this.safetyNet.runAll({
      correlationId: cid,
      speakerId: ctx.speakerId,
      tool: proposal.tool,
      args: proposal.args,
      tokens: { prompt: 0, completion: 0 },
      candidateOutput: JSON.stringify(proposal.args),
    });
    await this.emitGovernance(cid, envelope, decision, safety.vetoed);
    if (safety.vetoed) {
      return { routed: 'pipeline', correlationId: cid, ok: false, reason: `SafetyNet veto: ${safety.reasons.join('; ')}` };
    }
    if (decision.effect === 'deny') {
      return { routed: 'pipeline', correlationId: cid, ok: false, reason: `denied: ${decision.reason}` };
    }
    if (decision.effect === 'require_approval') {
      const { approvalId } = await this.approvals.request({ policyId: decision.policyIds[0] ?? 'policy', decision, action: proposal });
      this.staged.set(approvalId, { approvalId, correlationId: cid, action: proposal, decision });
      return { routed: 'pipeline', correlationId: cid, approvalId, approvalStatus: 'pending' };
    }

    // Allow → execute through the Supervisor.
    const r = await this.supervisor.run({
      governed: { kind: 'execute', decision, action: proposal },
      context: {
        correlationId: cid,
        speakerId: ctx.speakerId,
        tokens: { prompt: 0, completion: 0 },
        candidateOutput: JSON.stringify(proposal.args),
        toolCallHistory: [],
      },
      bundle,
    });
    await this.outcomeRecorder?.record(cid);
    return {
      routed: 'pipeline',
      correlationId: cid,
      ok: r.ok,
      reason: r.reason,
      ...(kbRefused ? { answerSource: 'logs' as const } : {}),
    };
  }

  private async handleRunbookOffer(
    cid: string,
    envelope: IntentEnvelope,
    ctx: { correlationId: string; speakerId: string; text: string },
  ): Promise<PipelineRouting> {
    const wanted = envelope.entities.runbookIds?.[0];
    const resolved = await this.resolveRunbook(wanted, ctx.text);
    if (!resolved) {
      return { routed: 'pipeline', correlationId: cid, ok: false, reason: 'no matching runbook action' };
    }

    const proposal: { tool: ToolName; args: Record<string, unknown> } = {
      tool: 'execute_runbook_script',
      args: { script_name: resolved.id },
    };
    const enriched: IntentEnvelope = {
      ...envelope,
      entities: { ...envelope.entities, runbookIds: [resolved.id], runbookDestructive: resolved.destructive },
    };

    const decision = this.policyEngine.evaluate(enriched, proposal);
    const safety = this.safetyNet.runAll({
      correlationId: cid,
      speakerId: ctx.speakerId,
      tool: proposal.tool,
      args: proposal.args,
      tokens: { prompt: 0, completion: 0 },
      candidateOutput: JSON.stringify(proposal.args),
    });
    await this.emitGovernance(cid, enriched, decision, safety.vetoed);
    if (safety.vetoed) {
      return { routed: 'pipeline', correlationId: cid, ok: false, reason: `SafetyNet veto: ${safety.reasons.join('; ')}` };
    }
    if (decision.effect === 'deny') {
      return { routed: 'pipeline', correlationId: cid, ok: false, reason: `denied: ${decision.reason}` };
    }
    if (decision.effect === 'require_approval') {
      const { approvalId } = await this.approvals.request({ policyId: decision.policyIds[0] ?? 'policy', decision, action: proposal });
      this.staged.set(approvalId, { approvalId, correlationId: cid, action: proposal, decision });
      return { routed: 'pipeline', correlationId: cid, approvalId, approvalStatus: 'pending' };
    }

    const r = await this.supervisor.run({
      governed: { kind: 'execute', decision, action: proposal },
      context: {
        correlationId: cid,
        speakerId: ctx.speakerId,
        tokens: { prompt: 0, completion: 0 },
        candidateOutput: JSON.stringify(proposal.args),
        toolCallHistory: [],
      },
      bundle: await this.assembler.assemble({ envelope: enriched, recent: await this.recentEvents() }),
    });
    await this.outcomeRecorder?.record(cid);
    return { routed: 'pipeline', correlationId: cid, ok: r.ok, reason: r.reason };
  }

  private async runGoverned(cid: string, action: { tool: ToolName; args: Record<string, unknown> }, decision: import('../governance/decision.js').Decision): Promise<PipelineRouting> {
    const r = await this.supervisor.run({
      governed: { kind: 'execute', decision, action },
      context: {
        correlationId: cid,
        speakerId: 'approver',
        tokens: { prompt: 0, completion: 0 },
        candidateOutput: JSON.stringify(action.args),
        toolCallHistory: [],
      },
      bundle: await this.assembler.assemble({ envelope: unknownEnvelope(cid), recent: await this.recentEvents() }),
    });
    await this.outcomeRecorder?.record(cid);
    return { routed: 'pipeline', correlationId: cid, ok: r.ok, reason: r.reason };
  }

  private async resolveRunbook(
    wanted: string | undefined,
    text: string,
  ): Promise<{ id: string; destructive: boolean } | undefined> {
    if (!this.runbookProvider) return undefined;
    try {
      const actions = await this.runbookProvider.list();
      const match = wanted
        ? actions.find((a) => a.id === wanted)
        : actions.find((a) => text.toLowerCase().includes(a.name.toLowerCase()));
      if (match) return { id: match.id, destructive: match.destructive };
      // Fuzzy: match on description keywords ("restart the checkout pod").
      const descMatch = actions.find((a) => a.description.split(/\s+/).some((w) => w.length > 3 && text.toLowerCase().includes(w.toLowerCase())));
      return descMatch ? { id: descMatch.id, destructive: descMatch.destructive } : undefined;
    } catch {
      return undefined;
    }
  }

  private queryFrom(envelope: IntentEnvelope): string {
    const ticket = envelope.entities.ticketKeys?.[0];
    if (ticket) return ticket;
    const svc = envelope.entities.services?.[0];
    if (svc) return svc;
    return 'errors';
  }

  private summaryOf(envelope: IntentEnvelope): string {
    const parts: string[] = [];
    if (envelope.entities.severity) parts.push(envelope.entities.severity);
    if (envelope.entities.services?.length) parts.push(envelope.entities.services.join(', '));
    return parts.length ? parts.join(' ') : 'proactive alert';
  }

  private async recentEvents(): Promise<DecisionEvent[]> {
    const out: DecisionEvent[] = [];
    const cutoff = this.now() - 60_000;
    for await (const e of this.eventLog.query({ from: cutoff, to: this.now() })) {
      out.push(e);
      if (out.length >= 10) break;
    }
    return out;
  }

  private async emitGovernance(
    cid: string,
    envelope: IntentEnvelope,
    decision: import('../governance/decision.js').Decision,
    vetoed: boolean,
  ): Promise<void> {
    await this.eventLog.append({
      correlationId: cid,
      ts: this.now(),
      layer: 'governance',
      source: 'internal',
      kind: 'governance',
      intent: envelope,
      decision: { ...decision, unconditionalSafetyNetCheck: true },
    });
    if (vetoed) {
      await this.eventLog.append({
        correlationId: cid,
        ts: this.now(),
        layer: 'governance',
        source: 'internal',
        kind: 'safety_net',
        vetoed: true,
        check: 'runAll',
        reason: 'safety-net veto during governed dispatch',
      });
    }
  }
}

function unknownEnvelope(cid: string): IntentEnvelope {
  return { intent: { kind: 'unknown' }, confidence: 0, entities: {}, rawContext: { source: 'internal' as never, ts: Number(cid.split('-')[0] ?? 0) || 0, payload: {} } };
}

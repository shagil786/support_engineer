/**
 * LLM-backed intent classifier (Understanding layer, spec §4).
 *
 * Two-path by design: the LLM is the ceiling, the deterministic
 * LegacyClassifierAdapter is the floor. Degradation is honest:
 *  - unwired LLM, unparseable output, or schema-invalid output → fallback
 *  - transport/network failures → propagate (never silently degrade)
 *
 * Every classification (LLM or fallback) emits an `understanding`
 * DecisionEvent when an EventLog is wired.
 */
import { z } from 'zod';
import { LlmError, OpenAiCompatibleClient } from '../support-voice-agent/tools/llm.js';
import type { LlmClient, LlmMessage } from '../support-voice-agent/tools/llm.js';
import type { IntentEnvelope, EventSource } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import { correlationId } from '../event-log/correlation.js';
import { LegacyClassifierAdapter, type ClassifyInput } from './legacy/classifier-adapter.js';

const IntentSchema = z.object({
  intent: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('meeting_response'), subKind: z.enum(['question', 'feedback', 'runbook_offer', 'complaint', 'critical', 'mute', 'wake']) }),
    z.object({ kind: z.literal('async_triage'), subKind: z.enum(['incident', 'service_request', 'question', 'fyi']) }),
    z.object({ kind: z.literal('proactive_alert'), subKind: z.enum(['incident', 'anomaly', 'slo_breach']) }),
    z.object({ kind: z.literal('human_action'), subKind: z.enum(['approval', 'rejection', 'edit', 'answer']) }),
    z.object({ kind: z.literal('unknown') }),
  ]),
  confidence: z.number().min(0).max(1),
  entities: z.object({
    ticketKeys: z.array(z.string()).optional(),
    runbookIds: z.array(z.string()).optional(),
    services: z.array(z.string()).optional(),
    severity: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']).optional(),
    speakerId: z.string().optional(),
  }),
  rawContext: z.object({
    source: z.enum(['meeting', 'jira', 'slack', 'cloudwatch', 'splunk', 'cron']),
    ts: z.number(),
    payload: z.unknown(),
  }),
});

/** The prompt must carry the EXACT discriminated union the schema enforces:
 *  without it, models invent plausible kinds ("log_query", "support_request")
 *  that fail validation and silently degrade every request to the legacy
 *  floor — the LLM ceiling never engages. Entities are likewise restricted
 *  to the schema's known keys; anything else fails the strict object. */
const SYSTEM_PROMPT =
  'You classify support-engineer inputs into a strict JSON envelope. Output ONLY the JSON object, no prose.\n' +
  'intent.kind must be exactly one of: meeting_response, async_triage, proactive_alert, human_action, unknown.\n' +
  'subKind depends on kind:\n' +
  '- meeting_response: question | feedback | runbook_offer | complaint | critical | mute | wake\n' +
  '- async_triage: incident | service_request | question | fyi\n' +
  '- proactive_alert: incident | anomaly | slo_breach\n' +
  '- human_action: approval | rejection | edit | answer\n' +
  '- unknown: omit subKind\n' +
  'confidence: number 0..1.\n' +
  'entities keys (all optional, omit unknown keys): ticketKeys (string[]), runbookIds (string[]), services (string[]), severity (P0|P1|P2|P3|P4), speakerId (string), runbookDestructive (boolean).\n' +
  'rawContext: { source: meeting|jira|slack|cloudwatch|splunk|cron, ts: number, payload: any } — copy source/ts/payload from the input verbatim.\n' +
  'Example: {"intent":{"kind":"meeting_response","subKind":"question"},"confidence":0.9,"entities":{"services":["api"]},"rawContext":{"source":"meeting","ts":123,"payload":{}}}';

export interface IntentClassifierOptions {
  llm: LlmClient;
  fallback: LegacyClassifierAdapter;
  eventLog?: EventLog;
  now?: () => number;
}

export class IntentClassifier {
  private readonly llm: LlmClient;
  private readonly fallback: LegacyClassifierAdapter;
  private readonly eventLog?: EventLog;
  private readonly now: () => number;

  constructor(opts: IntentClassifierOptions) {
    this.llm = opts.llm;
    this.fallback = opts.fallback;
    this.eventLog = opts.eventLog;
    this.now = opts.now ?? Date.now;
  }

  /** Classify one input. `join.correlationId` lets a caller (e.g. the
   *  orchestrated pipeline) stamp the emitted `understanding` event with the
   *  request's own correlation id so the whole trail joins; when omitted,
   *  a fresh id is minted (previous behavior). */
  async classify(input: ClassifyInput, join?: { correlationId?: string }): Promise<IntentEnvelope> {
    // Fast-path: an unwired LLM is a configured condition, not an error.
    if (!this.llm.isWired()) {
      return this.useFallback(input, 'unwired', join?.correlationId);
    }

    const ts = this.now();
    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(input) },
    ];

    let raw: string;
    try {
      // Generous budget: reasoning models spend tokens before content;
      // too small a cap yields empty content (malformed → honest fallback).
      const resp = await this.llm.complete({ messages, tools: [], tool_choice: 'none', temperature: 0, max_tokens: 4000 });
      const content = resp.choices[0]?.message?.content;
      if (typeof content !== 'string') {
        return this.useFallback(input, 'no_content');
      }
      raw = content;
    } catch (e) {
      if (e instanceof LlmError && e.code === 'unwired') {
        return this.useFallback(input, 'unwired');
      }
      // Transport/HTTP/malformed failures propagate — honest degradation.
      throw e;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.useFallback(input, 'parse_error');
    }

    const result = IntentSchema.safeParse(parsed);
    if (!result.success) {
      return this.useFallback(input, 'schema_invalid', join?.correlationId);
    }

    const envelope = result.data as IntentEnvelope;
    await this.emitEvent(input, envelope, ts, 'llm', join?.correlationId);
    return envelope;
  }

  private async useFallback(input: ClassifyInput, reason: string, correlationIdOverride?: string): Promise<IntentEnvelope> {
    const env = this.fallback.classify(input);
    await this.emitEvent(input, env, this.now(), reason, correlationIdOverride);
    return env;
  }

  private async emitEvent(input: ClassifyInput, envelope: IntentEnvelope, ts: number, via: string, correlationIdOverride?: string): Promise<void> {
    if (!this.eventLog) return;
    await this.eventLog.append({
      correlationId: correlationIdOverride ?? correlationId(ts),
      ts,
      layer: 'understanding',
      source: input.source as EventSource,
      kind: 'understanding',
      envelope,
      contextBundleRef: `via:${via}`,
    });
  }
}

/** Re-exported so callers can wire the concrete client without importing internals. */
export { OpenAiCompatibleClient };

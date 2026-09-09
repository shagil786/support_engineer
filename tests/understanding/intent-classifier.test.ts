import { describe, it, expect } from 'vitest';
import { IntentClassifier } from '../../src/understanding/intent-classifier';
import { LegacyClassifierAdapter } from '../../src/understanding/legacy/classifier-adapter';
import { LlmError, OpenAiCompatibleClient } from '../../src/support-voice-agent/tools/llm';
import type { EventLog, EventFilter } from '../../src/event-log/log';
import type { DecisionEvent } from '../../src/event-log/types';

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const GOOD_ENVELOPE = {
  intent: { kind: 'meeting_response', subKind: 'question' },
  confidence: 0.93,
  entities: { ticketKeys: ['SUPPORT-7'] },
  rawContext: { source: 'meeting', ts: 1, payload: {} },
};

/** Returns valid envelope JSON for SUPPORT-7 texts, non-JSON otherwise. */
const fakeFetch: typeof fetch = (_input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const text = body.messages?.[body.messages.length - 1]?.content ?? '';
  if (/support-7/i.test(text)) {
    return json({ id: 'cmpl-1', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(GOOD_ENVELOPE) }, finish_reason: 'stop' }] });
  }
  return json({ id: 'cmpl-2', choices: [{ index: 0, message: { role: 'assistant', content: 'not-json' }, finish_reason: 'stop' }] });
};

/** Minimal in-memory EventLog fake for asserting emissions. */
class MemEventLog implements EventLog {
  readonly events: DecisionEvent[] = [];
  async append(event: DecisionEvent): Promise<void> {
    this.events.push(event);
  }
  async *query(_filter: EventFilter): AsyncIterable<DecisionEvent> {
    return;
  }
}

describe('IntentClassifier system prompt', () => {
  // The prompt is the schema's only voice to the model: without the exact
  // discriminated union, models invent plausible kinds ("log_query",
  // "support_request") that fail Zod and silently degrade EVERY request to
  // the legacy floor — the LLM ceiling never engages. This test pins the
  // contract so prompt and schema can never drift apart again.
  it('enumerates every kind and subKind the schema accepts', async () => {
    const seen: Array<{ system?: string }> = [];
    const probe: typeof fetch = (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      seen.push({ system: body.messages?.[0]?.content });
      return json({ id: 'cmpl', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(GOOD_ENVELOPE) } }] });
    };
    const c = new IntentClassifier({
      llm: new OpenAiCompatibleClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', request: probe }),
      fallback: new LegacyClassifierAdapter(),
    });
    await c.classify({ text: 'x', source: 'meeting', ts: 1 });
    const prompt = seen[0]?.system ?? '';
    for (const kind of ['meeting_response', 'async_triage', 'proactive_alert', 'human_action', 'unknown']) {
      expect(prompt).toContain(kind);
    }
    for (const sub of ['question', 'feedback', 'runbook_offer', 'complaint', 'critical', 'mute', 'wake', 'incident', 'service_request', 'fyi', 'anomaly', 'slo_breach', 'approval', 'rejection', 'edit', 'answer']) {
      expect(prompt).toContain(sub);
    }
    // Entity keys too — unknown keys fail the strict entities object.
    for (const key of ['ticketKeys', 'runbookIds', 'services', 'severity', 'speakerId', 'runbookDestructive']) {
      expect(prompt).toContain(key);
    }
    // Precedence rule: the deterministic floor (classifier-adapter) checks
    // intents in a fixed order, offers before questions before wake. Without
    // the same rule in the prompt, the LLM ceiling classifies action requests
    // ("please restart all pods") as wake or question — a destructive runbook
    // then bypasses approval staging. Found live via the operator console.
    expect(prompt).toContain('subKind precedence for meeting_response');
    expect(prompt).toContain('runbook_offer');
  });
});

describe('IntentClassifier', () => {
  it('uses the LLM when wired and validates the envelope with Zod', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    const env = await c.classify({ text: "what's the status of SUPPORT-7?", source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'question' });
    expect(env.entities.ticketKeys).toEqual(['SUPPORT-7']);
    expect(env.confidence).toBeCloseTo(0.93);
  });

  it('falls back to legacy on Zod/JSON parse failure', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    const env = await c.classify({ text: 'something is broken', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'complaint' });
  });

  it('falls back to legacy when the LLM is unwired', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '', request: fakeFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    const env = await c.classify({ text: 'Users hate the new UI', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'feedback' });
  });

  it('rejects schema-invalid LLM output (entity type violation) via fallback', async () => {
    const badType: typeof fetch = (_i, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const text = body.messages?.[body.messages.length - 1]?.content ?? '';
      const bad = { ...GOOD_ENVELOPE, entities: { ticketKeys: [123] } };
      return json({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(text.includes('support') ? bad : { bogus: true }) }, finish_reason: 'stop' }] });
    };
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: badType });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    const env = await c.classify({ text: "what's the status of SUPPORT-7?", source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'question' }); // legacy path result
    expect(env.entities.ticketKeys).toEqual(['SUPPORT-7']);
    expect(env.confidence).toBe(1); // legacy confidence, not the LLM's
  });

  it('propagates transport failures as LlmError instead of silently degrading', async () => {
    const failFetch: typeof fetch = () => Promise.reject(new Error('boom'));
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: failFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    await expect(c.classify({ text: 'hello', source: 'meeting', ts: 1 })).rejects.toBeInstanceOf(LlmError);
  });

  it('emits an understanding DecisionEvent for both LLM and fallback paths', async () => {
    const log = new MemEventLog();
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter(), eventLog: log });
    await c.classify({ text: "what's the status of SUPPORT-7?", source: 'meeting', ts: 1 }); // LLM path
    await c.classify({ text: 'something is broken', source: 'meeting', ts: 1 }); // fallback path
    expect(log.events).toHaveLength(2);
    expect(log.events.every((e) => e.kind === 'understanding' && e.layer === 'understanding' && e.source === 'meeting')).toBe(true);
    const understanding = log.events.filter((e): e is Extract<DecisionEvent, { kind: 'understanding' }> => e.kind === 'understanding');
    expect(understanding.every((e) => typeof e.contextBundleRef === 'string' && e.contextBundleRef.length > 0)).toBe(true);
  });
});

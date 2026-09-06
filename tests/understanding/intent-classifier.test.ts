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

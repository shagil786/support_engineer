import { describe, it, expect } from 'vitest';
import { TriageAgent } from '../../../src/execution/agents/triage';
import { OpenAiCompatibleClient } from '../../../src/support-voice-agent/tools/llm';
import type { ContextBundle } from '../../../src/understanding/context-assembler';

const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

const bundle = (over: Partial<ContextBundle> = {}): ContextBundle => ({
  envelope: {
    intent: { kind: 'meeting_response', subKind: 'question' },
    confidence: 1,
    entities: { ticketKeys: ['SUPPORT-7'] },
    rawContext: { source: 'meeting', ts: 1, payload: {} },
  },
  episodes: [],
  recent: [],
  ...over,
});

describe('TriageAgent', () => {
  it('returns a structured triage decision from the LLM', async () => {
    const fakeFetch: typeof fetch = (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ content?: string }> };
      if (body.messages?.[1]?.content?.includes('SUPPORT-7')) {
        return json({
          id: '1',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ subKind: 'question', severity: 'P2', suggestedTools: ['query_logs'] }) },
            finish_reason: 'stop',
          }],
        });
      }
      return json({
        id: '2',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ subKind: 'unknown', suggestedTools: [] }) }, finish_reason: 'stop' }],
      });
    };
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const agent = new TriageAgent({ llm });
    const r = await agent.run(bundle());
    expect(r.source).toBe('llm');
    expect(r.decision.subKind).toBe('question');
    expect(r.decision.suggestedTools).toContain('query_logs');
  });

  it('falls back deterministically when the LLM is unwired', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    const agent = new TriageAgent({ llm });
    const r = await agent.run(bundle({
      envelope: {
        intent: { kind: 'meeting_response', subKind: 'runbook_offer' },
        confidence: 1,
        entities: { runbookIds: ['restart-all'] },
        rawContext: { source: 'meeting', ts: 1, payload: {} },
      },
    }));
    expect(r.source).toBe('fallback');
    expect(r.decision.subKind).toBe('runbook_offer');
    expect(r.decision.suggestedTools).toContain('execute_runbook_script');
  });

  it('falls back when the LLM output fails schema validation', async () => {
    const fakeFetch: typeof fetch = () =>
      json({
        id: '3',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ subKind: 'HACK', suggestedTools: ['deploy_to_prod'] }) }, finish_reason: 'stop' }],
      });
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const agent = new TriageAgent({ llm });
    const r = await agent.run(bundle());
    expect(r.source).toBe('fallback');
    // Fallback ignores the poisoned LLM output entirely: ticketKey → query_logs.
    expect(r.decision.suggestedTools).toEqual(['query_logs']);
  });

  it('proposes a meeting interrupt for proactive alerts', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    const agent = new TriageAgent({ llm });
    const r = await agent.run(bundle({
      envelope: {
        intent: { kind: 'proactive_alert', subKind: 'incident' },
        confidence: 1,
        entities: { severity: 'P1' },
        rawContext: { source: 'cloudwatch', ts: 1, payload: {} },
      },
    }));
    expect(r.decision.suggestedTools).toContain('meeting_interrupt');
  });
});

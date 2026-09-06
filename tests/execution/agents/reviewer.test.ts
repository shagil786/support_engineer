import { describe, it, expect } from 'vitest';
import { ReviewerAgent } from '../../../src/execution/agents/reviewer';
import { OpenAiCompatibleClient } from '../../../src/support-voice-agent/tools/llm';
import type { ContextBundle } from '../../../src/understanding/context-assembler';

const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

const bundle: ContextBundle = {
  envelope: {
    intent: { kind: 'meeting_response', subKind: 'question' },
    confidence: 1,
    entities: {},
    rawContext: { source: 'meeting', ts: 1, payload: {} },
  },
  episodes: [],
  recent: [],
};

describe('ReviewerAgent', () => {
  it('parses a fail verdict with feedback from the LLM', async () => {
    const fakeFetch: typeof fetch = () =>
      json({
        id: '1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: JSON.stringify({ verdict: 'fail', feedback: 'log rows do not mention the checkout pod' }) },
          finish_reason: 'stop',
        }],
      });
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const agent = new ReviewerAgent({ llm });
    const r = await agent.run(bundle);
    expect(r.decision.verdict).toBe('fail');
    expect(r.decision.feedback).toContain('checkout pod');
  });

  it('falls back to pass when the LLM is unwired', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    const agent = new ReviewerAgent({ llm });
    const r = await agent.run(bundle);
    expect(r.source).toBe('fallback');
    expect(r.decision.verdict).toBe('pass');
  });

  it('falls back on unparseable LLM output', async () => {
    const fakeFetch: typeof fetch = () =>
      json({
        id: '2',
        choices: [{ index: 0, message: { role: 'assistant', content: 'I think it looks great!' }, finish_reason: 'stop' }],
      });
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const agent = new ReviewerAgent({ llm });
    const r = await agent.run(bundle);
    expect(r.source).toBe('fallback');
    expect(r.decision.verdict).toBe('pass');
  });
});

import { describe, it, expect } from 'vitest';
import { parseSlackMention } from '../../src/surface/async/slack-mention';

describe('parseSlackMention', () => {
  it('extracts user and intent', () => {
    const env = parseSlackMention({ text: 'hey agent, status?', user: 'U1' });
    expect(env?.intent.kind).toBe('async_triage');
    expect(env?.entities.speakerId).toBe('U1');
    expect(env?.rawContext.source).toBe('slack');
  });

  it('returns undefined on bad payloads', () => {
    expect(parseSlackMention({ text: 'hi' })).toBeUndefined();
    expect(parseSlackMention({ user: 'U1' })).toBeUndefined();
    expect(parseSlackMention(null)).toBeUndefined();
  });
});

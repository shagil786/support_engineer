import { describe, it, expect } from 'vitest';
import { LegacyClassifierAdapter } from '../../src/understanding/legacy/classifier-adapter';
import {
  containsWakeWord,
  isShutUpCommand,
  isCriticalDeclaration,
  isFeedback,
  isVagueTechnicalComplaint,
  isDirectQuestion,
} from '../../src/support-voice-agent/heuristics';

describe('LegacyClassifierAdapter parity', () => {
  const a = new LegacyClassifierAdapter();

  it('classifies a wake-word question with entities', () => {
    const env = a.classify({ text: 'hey agent, what is the status of SUPPORT-7?', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'question' });
    expect(env.entities.ticketKeys).toEqual(['SUPPORT-7']);
    expect(env.confidence).toBe(1);
    expect(env.rawContext).toEqual({ source: 'meeting', ts: 1, payload: {} });
  });

  it('classifies a mute command', () => {
    const env = a.classify({ text: 'agent, shut up', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'mute' });
  });

  it('classifies a critical declaration with severity', () => {
    const env = a.classify({ text: 'This is a P1', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'critical' });
    expect(env.entities.severity).toBe('P1');
  });

  it('classifies a P0 declaration as P0', () => {
    const env = a.classify({ text: 'this is a p0', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'critical' });
    expect(env.entities.severity).toBe('P0');
  });

  it('classifies feedback', () => {
    const env = a.classify({ text: 'Users hate the new UI', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'feedback' });
  });

  it('classifies a vague complaint', () => {
    const env = a.classify({ text: 'something is broken', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'complaint' });
  });

  it('flags telemetry questions as live-data (floor parity with the LLM ceiling rule)', () => {
    // "check the error logs" asks about CURRENT system state — the static KB
    // must not answer it from a lexically-overlapping chunk.
    const env = a.classify({ text: 'agent, can you check the error logs for the api?', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'question', liveData: true });
    // How-to / postmortem phrasings stay static-document questions (KB-first).
    const howTo = a.classify({ text: 'agent, what do I do when the checkout service stops responding?', source: 'meeting', ts: 1 });
    expect(howTo.intent).toEqual({ kind: 'meeting_response', subKind: 'question' });
    if (howTo.intent.kind === 'meeting_response') expect(howTo.intent.liveData).toBeUndefined();
  });

  it('classifies a runbook offer', () => {
    const env = a.classify({ text: 'hey agent, can you restart the checkout pod?', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'meeting_response', subKind: 'runbook_offer' });
    expect(env.entities.runbookIds).toBeUndefined();
  });

  it('claims the widened operator-verb family as runbook offers (LLM-less availability)', () => {
    // Each of these verbs appears in real catalogs (the shipped example has
    // "fail the database over to the standby replica"); a missed claim costs
    // availability, while a false claim is cheap — the KB resolver refuses
    // without a confident match and destructive candidates stage anyway.
    const verbs = [
      'please restart the pod',
      'please fail the database over to the standby replica',
      'can you promote the standby to primary',
      'could you drain the connection pool',
      'please rotate the TLS cert',
      'would you flush the redis cache',
      'please scale the worker pool up',
      'can you redeploy the web frontend',
      'please roll back the last deploy',
    ];
    for (const text of verbs) {
      const env = a.classify({ text, source: 'meeting', ts: 1 });
      expect(env.intent, text).toEqual({ kind: 'meeting_response', subKind: 'runbook_offer' });
    }
    // Chatter that merely mentions a verb is NOT an offer: the politeness
    // prefix guards the claim.
    const mention = a.classify({ text: 'the failover last night was rough', source: 'meeting', ts: 1 });
    expect(mention.intent).not.toEqual({ kind: 'meeting_response', subKind: 'runbook_offer' });
  });

  it('carries the speakerId into entities when provided', () => {
    const env = a.classify({ text: 'something is broken', source: 'meeting', ts: 1, speakerId: 'alice' });
    expect(env.entities.speakerId).toBe('alice');
  });

  it('returns unknown for unclassifiable text', () => {
    const env = a.classify({ text: 'ok', source: 'meeting', ts: 1 });
    expect(env.intent).toEqual({ kind: 'unknown' });
    expect(env.confidence).toBe(0);
  });

  it('reuses heuristics functions bit-for-bit (delegates, does not reimplement)', () => {
    expect(containsWakeWord('hey agent')).toBe(true);
    expect(isShutUpCommand('agent, shut up')).toBe(true);
    expect(isCriticalDeclaration('This is a P1')).toBe(true);
    expect(isFeedback('users hate the UI')).toBe(true);
    expect(isVagueTechnicalComplaint("it's down")).toBe(true);
    expect(isDirectQuestion("what's the status of SUPPORT-7?")).toBe(true);
  });
});

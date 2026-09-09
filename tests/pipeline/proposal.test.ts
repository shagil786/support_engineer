/**
 * Unit tests for the proposal shaper — envelope → tool proposal shaping.
 *
 * These pin the precedence rules that decide WHAT the governed dispatch
 * evaluates: which log query a question proposes (ticket → service →
 * generic), what an interrupt summarizes (severity + services → honest
 * generic), and the runbook execute shape. Pure functions, no collaborators.
 */
import { describe, it, expect } from 'vitest';
import { interruptMessageFrom, logQueryFrom, runbookProposal, shapeProposal } from '../../src/pipeline/proposal';
import type { IntentEnvelope } from '../../src/event-log/types';

const envelopeWith = (entities: IntentEnvelope['entities']): IntentEnvelope => ({
  intent: { kind: 'meeting_response', subKind: 'question' },
  confidence: 1,
  entities,
  rawContext: { source: 'meeting', ts: 1_000_000, payload: {} },
});

describe('logQueryFrom (question → query_logs shaping)', () => {
  it('prefers the extracted ticket key: the question IS the ticket', () => {
    expect(logQueryFrom(envelopeWith({ ticketKeys: ['SUPPORT-7'], services: ['api'] }))).toBe('SUPPORT-7');
  });

  it('falls back to the extracted service when no ticket is present', () => {
    expect(logQueryFrom(envelopeWith({ services: ['payment-api'] }))).toBe('payment-api');
  });

  it('uses only the first of each (a single query, not a list)', () => {
    expect(logQueryFrom(envelopeWith({ ticketKeys: ['SUPPORT-1', 'SUPPORT-2'] }))).toBe('SUPPORT-1');
    expect(logQueryFrom(envelopeWith({ services: ['api', 'web'] }))).toBe('api');
  });

  it('defaults to the generic error sweep when the classifier extracted nothing', () => {
    expect(logQueryFrom(envelopeWith({}))).toBe('errors');
  });
});

describe('interruptMessageFrom (non-question → meeting_interrupt shaping)', () => {
  it('leads with severity and lists the affected services', () => {
    expect(interruptMessageFrom(envelopeWith({ severity: 'P1', services: ['payment-api', 'checkout'] }))).toBe(
      'P1 payment-api, checkout',
    );
  });

  it('carries severity or services alone', () => {
    expect(interruptMessageFrom(envelopeWith({ severity: 'P0' }))).toBe('P0');
    expect(interruptMessageFrom(envelopeWith({ services: ['api'] }))).toBe('api');
  });

  it('degrades to the honest generic when the envelope extracted nothing', () => {
    expect(interruptMessageFrom(envelopeWith({}))).toBe('proactive alert');
  });
});

describe('shapeProposal', () => {
  it('a question with a ticket key proposes the read-only jira_get_issue', () => {
    expect(shapeProposal(envelopeWith({ ticketKeys: ['SUPPORT-9'] }), true)).toEqual({
      tool: 'jira_get_issue',
      args: { issue_key: 'SUPPORT-9' },
    });
  });

  it('a question without a ticket proposes a read-only log query with the shaped query_string', () => {
    expect(shapeProposal(envelopeWith({ services: ['api'] }), true)).toEqual({
      tool: 'query_logs',
      args: { query_string: 'api' },
    });
  });

  it('a non-question proposes an interrupt with the shaped message', () => {
    expect(shapeProposal(envelopeWith({ severity: 'P1', services: ['checkout'] }), false)).toEqual({
      tool: 'meeting_interrupt',
      args: { message: 'P1 checkout' },
    });
  });
});

describe('runbookProposal', () => {
  it('a resolved offer becomes an execute proposal for the concrete action id', () => {
    expect(runbookProposal({ id: 'restart-all', destructive: true })).toEqual({
      tool: 'execute_runbook_script',
      args: { script_name: 'restart-all' },
    });
    expect(runbookProposal({ id: 'clear-cache', destructive: false })).toEqual({
      tool: 'execute_runbook_script',
      args: { script_name: 'clear-cache' },
    });
  });
});

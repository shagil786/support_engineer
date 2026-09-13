/**
 * Scenario synthesis (ADR-0011) — divergence → eval scenario pinning.
 *
 * The loop: shadow replay reports a candidate's behavior change on
 * recorded traffic; synthesis renders that divergence as a ready-to-add
 * eval scenario whose `expect` is the RECORDED (live) effect. Pinned
 * invariants:
 *  - `expect` is always the recorded effect, never the candidate's.
 *  - A card number in recorded args NEVER survives into a committed
 *    scenario (the repo's never-emit-credit-card invariant).
 *  - Scenarios already present (same tool+args+expect) are skipped; ids
 *    are unique against both the existing file and the batch.
 *  - The rendered fragment re-parses and ROUND-TRIPS: appended to the
 *    shipped scenarios, the live bundle passes every pinned scenario.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { synthesizeScenarios, toScenarioFragmentYaml } from '../../src/learning/scenario-synthesis';
import { PolicyEngine } from '../../src/governance/policy-engine';
import { EvalRunner } from '../../src/learning/eval-runner';
import type { ShadowDivergence } from '../../src/learning/shadow-replay';
import type { IntentEnvelope } from '../../src/event-log/types';

const defaultYaml = readFileSync(join(process.cwd(), 'policies/default.yaml'), 'utf8');
const scenariosYaml = readFileSync(join(process.cwd(), 'policies/eval/scenarios.yaml'), 'utf8');

const intent = (): IntentEnvelope => ({
  intent: { kind: 'meeting_response', subKind: 'question' },
  confidence: 1,
  entities: { ticketKeys: ['SUPPORT-7'] },
  rawContext: { source: 'meeting', ts: 1_000, payload: {} },
});

const divergence = (over: Partial<ShadowDivergence> = {}): ShadowDivergence => ({
  correlationId: 'cid-1',
  ts: 1_000,
  tool: 'query_evidence',
  recorded: 'allow',
  candidate: 'deny',
  intent: intent(),
  action: { tool: 'query_evidence', args: { query_string: 'errors' } },
  ...over,
});

describe('synthesizeScenarios', () => {
  it('pins the RECORDED effect as expect, with the traffic shape preserved', () => {
    const [pin] = synthesizeScenarios({ divergences: [divergence()] });
    expect(pin).toEqual({
      id: 'shadow_query_evidence_allow',
      intent: { kind: 'meeting_response', subKind: 'question' },
      entities: { ticketKeys: ['SUPPORT-7'] },
      action: { tool: 'query_evidence', args: { query_string: 'errors' } },
      expect: 'allow',
    });
  });

  it('is byte-compatible with the EvalRunner scenario schema', () => {
    const pins = synthesizeScenarios({ divergences: [divergence()] });
    const yaml = `scenarios:\n${toScenarioFragmentYaml(pins)}`;
    // EvalRunner rejects malformed scenario files loudly; a round-trip parse
    // must succeed and re-serialize must contain every pinned expect.
    const parsed = parseYaml(yaml) as { scenarios: Array<Record<string, unknown>> };
    expect(parsed.scenarios).toHaveLength(1);
    expect(parsed.scenarios[0]?.id).toBe('shadow_query_evidence_allow');
    expect(parsed.scenarios[0]?.expect).toBe('allow');
  });

  it('uses the LIVE bundle decision as expect — round-trip passes the live engine', () => {
    // query_evidence is allowed by the live bundle; the candidate (narrowed)
    // would deny it. The pinned scenario must PASS against the live engine,
    // i.e. it encodes the behavior the live bundle promised.
    const pins = synthesizeScenarios({ divergences: [divergence()] });
    const live = new PolicyEngine({ yaml: defaultYaml });
    const evalRes = new EvalRunner({ engine: live }).runScenarios(`scenarios:\n${toScenarioFragmentYaml(pins)}`);
    expect(evalRes.failures).toEqual([]);
    expect(evalRes.total).toBe(1);
  });
});

describe('synthesizeScenarios (dedupe + redaction + ids)', () => {
  it('skips divergences already pinned in the existing scenario file', () => {
    const existing = `scenarios:\n  - id: already_there\n    intent: { kind: meeting_response, subKind: question }\n    entities: {}\n    action: { tool: query_evidence, args: { query_string: errors } }\n    expect: allow\n`;
    const pins = synthesizeScenarios({ divergences: [divergence()], existingScenariosYaml: existing });
    expect(pins).toEqual([]);
  });

  it('dedupes within the batch (same tool+args+expect from two cids → one pin)', () => {
    const pins = synthesizeScenarios({
      divergences: [divergence({ correlationId: 'cid-1' }), divergence({ correlationId: 'cid-2', ts: 2_000 })],
    });
    expect(pins).toHaveLength(1);
  });

  it('generates unique ids on collision with existing ids', () => {
    const existing = `scenarios:\n  - id: shadow_query_evidence_allow\n    intent: { kind: meeting_response, subKind: question }\n    entities: {}\n    action: { tool: query_evidence, args: { query_string: 'different args' } }\n    expect: allow\n`;
    const pins = synthesizeScenarios({ divergences: [divergence()], existingScenariosYaml: existing });
    expect(pins).toHaveLength(1); // different args → NOT deduped, but id must not collide
    expect(pins[0]?.id).toBe('shadow_query_evidence_allow_2');
  });

  it('redacts card-shaped tokens from args AND entities — never into a committed policy file', () => {
    const withCard = divergence({
      action: { tool: 'query_logs', args: { query_string: 'card 4111 1111 1111 1111 declined' } },
      intent: {
        intent: { kind: 'meeting_response', subKind: 'question' },
        confidence: 1,
        entities: { cardNumber: '4111 1111 1111 1111' },
        rawContext: { source: 'meeting', ts: 1_000, payload: {} },
      } as unknown as IntentEnvelope,
    });
    const pins = synthesizeScenarios({ divergences: [withCard] });
    const fragment = toScenarioFragmentYaml(pins);
    // The invariant: no card-shaped token survives into policies/. Both
    // args and entities must carry the redaction marker instead.
    expect(fragment).not.toMatch(/\b(?:\d[ -]*?){13,19}\b/);
    expect(fragment).toContain('[REDACTED]');
    expect(pins[0]?.action.args.query_string).toBe('card [REDACTED] declined');
    expect(pins[0]?.entities.cardNumber).toBe('[REDACTED]');
  });

  it('skips recorded effects the eval schema cannot pin (transform)', () => {
    const pins = synthesizeScenarios({
      divergences: [divergence({ recorded: 'transform', candidate: 'allow', tool: 'query_evidence' })],
    });
    expect(pins).toEqual([]);
  });

  it('renders a fragment with provenance comments, ready to paste under scenarios:', () => {
    const pins = synthesizeScenarios({ divergences: [divergence({ correlationId: 'cid-99', ts: 7_777 })] });
    const provenance = new Map([['shadow_query_evidence_allow', { correlationId: 'cid-99', ts: 7_777 }]]);
    const fragment = toScenarioFragmentYaml(pins, provenance);
    expect(fragment).toContain('cid=cid-99');
    expect(fragment).toContain('ts=7777');
    expect(fragment).toContain('shadow-replay pin (ADR-0011)');
    expect(fragment.startsWith('  # shadow-replay pin')).toBe(true);
  });
});

/**
 * End-to-end: the shipped scenario file plays the dedupe role. A divergence
 * the shipped suite already covers yields no new pin; a genuinely unpinned
 * tool yields a fresh pin that the live engine agrees with.
 */
describe('synthesis end-to-end (live file dedupe)', () => {
  it('does not re-pin something the shipped scenarios already cover', () => {
    // The shipped suite already pins query_logs allow for 'errors' — a
    // divergence on that exact shape yields no NEW pin.
    const existing = synthesizeScenarios({
      divergences: [
        divergence({
          tool: 'query_logs',
          action: { tool: 'query_logs', args: { query_string: 'errors' } },
        }),
      ],
      existingScenariosYaml: scenariosYaml,
    });
    expect(existing).toEqual([]);
  });

  it('a genuinely unpinned divergence (assess_blast_radius) yields a fresh pin and passes the live engine', () => {
    const unpinned = divergence({
      tool: 'assess_blast_radius',
      action: { tool: 'assess_blast_radius', args: { target: 'checkout-service' } },
    });
    const pins = synthesizeScenarios({ divergences: [unpinned], existingScenariosYaml: scenariosYaml });
    expect(pins).toHaveLength(1);
    expect(pins[0]?.id).toBe('shadow_assess_blast_radius_allow');
    // Live engine agrees (it is what recorded allow) — the pin is sound.
    const live = new PolicyEngine({ yaml: defaultYaml });
    const evalRes = new EvalRunner({ engine: live }).runScenarios(`scenarios:\n${toScenarioFragmentYaml(pins)}`);
    expect(evalRes.failures).toEqual([]);
  });
});
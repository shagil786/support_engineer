/**
 * EvalRunner (spec §7.3): evaluates shipped scenario suites against a
 * candidate policy bundle. The PromotionGate requires a fully-green run
 * before any promotion. Scenarios are Zod-validated — an invalid scenario
 * file fails loud rather than silently passing zero scenarios.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { PolicyEngine } from '../governance/policy-engine.js';
import type { IntentEnvelope } from '../event-log/types.js';
import type { ProposedAction } from '../governance/decision.js';

const ScenarioSchema = z.object({
  id: z.string().min(1),
  intent: z.object({
    kind: z.string(),
    subKind: z.string().optional(),
  }).passthrough(),
  entities: z.record(z.string(), z.unknown()).default({}),
  action: z.object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  expect: z.enum(['allow', 'deny', 'require_approval']),
});

const ScenarioFileSchema = z.object({
  scenarios: z.array(ScenarioSchema).min(1),
});

export interface EvalResult {
  total: number;
  passed: number;
  failures: Array<{ id: string; expected: string; got: string }>;
}

export interface EvalRunnerOptions {
  engine: PolicyEngine;
}

export class EvalRunner {
  constructor(private readonly opts: EvalRunnerOptions) {}

  runScenarios(scenariosYaml: string): EvalResult {
    const parsed: unknown = parseYaml(scenariosYaml);
    const file = ScenarioFileSchema.parse(parsed);

    // Report integrity: a duplicated id makes `passed/total` ambiguous and a
    // failure report unreadable — fail loud instead.
    const seen = new Set<string>();
    for (const s of file.scenarios) {
      if (seen.has(s.id)) throw new Error(`duplicate scenario id: ${s.id}`);
      seen.add(s.id);
    }

    let passed = 0;
    const failures: EvalResult['failures'] = [];
    for (const s of file.scenarios) {
      const env = buildEnvelope(s.intent, s.entities);
      const r = this.opts.engine.evaluate(env, s.action as ProposedAction);
      if (r.effect === s.expect) {
        passed++;
      } else {
        failures.push({ id: s.id, expected: s.expect, got: r.effect });
      }
    }
    return { total: file.scenarios.length, passed, failures };
  }
}

function buildEnvelope(
  intent: { kind: string; subKind?: string },
  entities: Record<string, unknown>,
): IntentEnvelope {
  const kind = intent.kind as IntentEnvelope['intent'] extends infer T ? T extends { kind: infer K } ? K : never : never;
  const base = { confidence: 1, entities: entities as IntentEnvelope['entities'], rawContext: { source: 'meeting' as const, ts: 0, payload: {} } };
  if (intent.subKind !== undefined) {
    return { intent: { kind, subKind: intent.subKind } as IntentEnvelope['intent'], ...base };
  }
  return { intent: { kind } as IntentEnvelope['intent'], ...base };
}

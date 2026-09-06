/**
 * Standalone SafetyNet regression runner — extracted from PromotionGate so
 * CI (and any other harness) can run the shipped must-veto scenarios without
 * a PolicyStore or a full gate. The PromotionGate delegates to this function;
 * the contract is identical: every scenario must veto, for the expected check.
 *
 * A scenario file that is malformed must fail loud, never silently pass zero
 * scenarios.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { SafetyNet } from '../governance/safety-net/index.js';

const SafetyNetScenarioSchema = z.object({
  id: z.string().min(1),
  intent: z.object({ kind: z.string(), subKind: z.string().optional() }).passthrough(),
  entities: z.record(z.string(), z.unknown()).default({}),
  action: z.object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  speakerId: z.string().min(1),
  expected_safety_net: z.enum(['rbac', 'injection', 'output', 'cost', 'loop']),
});

const SafetyNetFileSchema = z.object({ scenarios: z.array(SafetyNetScenarioSchema).min(1) });

/** Runs every must-veto scenario against the given SafetyNet. Throws on the
 *  first scenario that fails to veto, vetoes for the wrong check, or whose
 *  file is malformed. */
export function runSafetyNetRegression(scenariosYaml: string, safetyNet: SafetyNet): void {
  const file = SafetyNetFileSchema.parse(parseYaml(scenariosYaml));
  for (const s of file.scenarios) {
    const result = safetyNet.runAll({
      correlationId: `regression-${s.id}`,
      speakerId: s.speakerId,
      tool: s.action.tool,
      args: s.action.args,
      tokens: { prompt: 0, completion: 0 },
      candidateOutput: JSON.stringify(s.action.args),
    });
    if (!result.vetoed) {
      throw new Error(`SafetyNet regression: scenario '${s.id}' did not veto`);
    }
    const reasons = result.reasons.join(' ');
    if (!reasons.includes(s.expected_safety_net)) {
      throw new Error(
        `SafetyNet regression: scenario '${s.id}' vetoed for the wrong reason (expected ${s.expected_safety_net}): ${reasons}`,
      );
    }
  }
}

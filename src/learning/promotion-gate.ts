/**
 * PromotionGate (spec §7.3) — the ONLY writer to the PolicyStore.
 *
 * A suggestion is promoted only when ALL of the following hold:
 *  1. M-of-N signatures from holders of the policy_admin role (default M=2).
 *  2. The PATCHED CANDIDATE bundle passes every shipped eval scenario.
 *     (Evaluating the candidate — not the current bundle — is the point:
 *     a patch that regresses behavior is refused before it lands.)
 *  3. Every SafetyNet regression scenario still vetoes for the expected
 *     check. SafetyNet lives in code; bundles can never weaken it, and
 *     suggestions that try are refused outright.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { PolicyStore, PolicyBundle } from '../governance/policy-store.js';
import { PolicyEngine } from '../governance/policy-engine.js';
import { EvalRunner } from './eval-runner.js';
import type { SafetyNet } from '../governance/safety-net/index.js';
import type { EventLog } from '../event-log/log.js';
import type { PolicySuggestion } from './suggestion-queue.js';

const REQUIRED_SIGNATURES = 2;

const SuggestionSchema = z
  .object({
    id: z.string().min(1),
    rationale: z.string(),
    evidence: z.object({
      outcomeIds: z.array(z.string()),
      sampleSize: z.number(),
      confidence: z.number(),
    }),
    proposedChange: z.discriminatedUnion('type', [
      z.object({ type: z.literal('add_rule'), rule: z.record(z.string(), z.unknown()) }),
      z.object({ type: z.literal('modify_rule'), ruleId: z.string().min(1), patch: z.record(z.string(), z.unknown()) }),
      z.object({ type: z.literal('tighten_safety_net'), check: z.string().min(1) }),
      z.object({ type: z.literal('add_procedure'), procedure: z.record(z.string(), z.unknown()) }),
    ]),
    risk: z.enum(['low', 'medium', 'high']),
    estimatedImpact: z.object({ outcomeMetric: z.string(), expectedDelta: z.string() }),
  })
  .strict();

const SafetyNetScenarioSchema = z.object({
  id: z.string().min(1),
  intent: z.object({ kind: z.string(), subKind: z.string().optional() }).passthrough(),
  entities: z.record(z.string(), z.unknown()).default({}),
  action: z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }),
  speakerId: z.string().min(1),
  expected_safety_net: z.enum(['rbac', 'injection', 'output', 'cost', 'loop']),
});

const SafetyNetFileSchema = z.object({ scenarios: z.array(SafetyNetScenarioSchema).min(1) });

export interface PromotionGateOptions {
  store: PolicyStore;
  safetyNet: SafetyNet;
  evalScenariosPath: string;
  safetyNetScenariosPath: string;
  eventLog?: EventLog;
  /** Resolves whether a signer holds the policy_admin role. When omitted,
   *  only the signature COUNT is enforced (no role registry is wired). */
  hasPolicyAdminRole?: (signerId: string) => boolean;
  requiredSignatures?: number;
  now?: () => number;
}

export class PromotionGate {
  private readonly opts: PromotionGateOptions;
  private readonly required: number;
  private readonly now: () => number;

  constructor(opts: PromotionGateOptions) {
    this.opts = opts;
    this.required = Math.max(1, opts.requiredSignatures ?? REQUIRED_SIGNATURES);
    this.now = opts.now ?? Date.now;
  }

  async promote(suggestion: PolicySuggestion, signatures: string[]): Promise<PolicyBundle> {
    // 1. Signatures — count first, then role.
    if (signatures.length < this.required) {
      throw new Error(`Promotion requires ${this.required} signatures, got ${signatures.length}`);
    }
    const roleOf = this.opts.hasPolicyAdminRole;
    if (roleOf) {
      const nonAdmins = signatures.filter((s) => !roleOf(s));
      if (nonAdmins.length > 0) {
        throw new Error(`All signatures must hold the policy_admin role; rejected: ${nonAdmins.join(', ')}`);
      }
    }

    // 2. Validate the suggestion shape; refuse categories that never belong
    //    in a policy bundle.
    const parsed = SuggestionSchema.parse(suggestion);
    if (parsed.proposedChange.type === 'tighten_safety_net') {
      throw new Error('SafetyNet changes are code changes — propose them via PR review, not the policy store');
    }
    if (parsed.proposedChange.type === 'add_procedure') {
      throw new Error('procedures belong in episodic memory, not the policy bundle');
    }

    // 3. Build the candidate bundle.
    const current = this.opts.store.current();
    const candidateYaml = this.applyPatch(current.yaml, parsed);

    // 4. Eval the CANDIDATE (fail-closed: an invalid bundle cannot promote).
    let candidateEngine: PolicyEngine;
    try {
      candidateEngine = new PolicyEngine({ yaml: candidateYaml });
    } catch (e) {
      throw new Error(`candidate bundle is invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
    const evalYaml = readFileSync(this.opts.evalScenariosPath, 'utf8');
    const evalRes = new EvalRunner({ engine: candidateEngine }).runScenarios(evalYaml);
    if (evalRes.failures.length > 0) {
      throw new Error(`Eval failed: ${JSON.stringify(evalRes.failures)}`);
    }

    // 5. SafetyNet regression on the candidate's action space.
    this.runSafetyNetRegression();

    // 6. Persist + promote atomically via the store.
    const saved = await this.opts.store.save({
      yaml: candidateYaml,
      authoredBy: signatures[0] ?? 'unknown',
      signedBy: signatures.join('+'),
      parentVersion: current.version,
    });
    await this.opts.store.promote(saved.version, {
      promotedBy: signatures,
      evalRunId: `eval-${this.now()}`,
      safetyNetPassed: true,
    });

    // 7. Audit trail.
    if (this.opts.eventLog) {
      await this.opts.eventLog
        .append({
          correlationId: parsed.id,
          ts: this.now(),
          layer: 'learning',
          source: 'internal',
          kind: 'policy_promoted',
          policyId: parsed.id,
          bundleSha: saved.sha256,
          promotedBy: signatures,
        })
        .catch(() => {});
    }
    return saved;
  }

  private applyPatch(yaml: string, suggestion: z.output<typeof SuggestionSchema>): string {
    const parsed = parseYaml(yaml) as { rules: Array<Record<string, unknown>> };
    const rules = parsed.rules ?? [];
    const change = suggestion.proposedChange;

    if (change.type === 'modify_rule') {
      const idx = rules.findIndex((r) => r['id'] === change.ruleId);
      if (idx < 0) throw new Error(`rule not found: ${change.ruleId}`);
      rules[idx] = { ...rules[idx], ...change.patch };
    } else if (change.type === 'add_rule') {
      rules.push(change.rule);
    }
    return stringifyYaml({ rules });
  }

  private runSafetyNetRegression(): void {
    const yaml = readFileSync(this.opts.safetyNetScenariosPath, 'utf8');
    const file = SafetyNetFileSchema.parse(parseYaml(yaml));
    for (const s of file.scenarios) {
      const result = this.opts.safetyNet.runAll({
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
        throw new Error(`SafetyNet regression: scenario '${s.id}' vetoed for the wrong reason (expected ${s.expected_safety_net}): ${reasons}`);
      }
    }
  }
}

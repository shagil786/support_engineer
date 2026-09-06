/**
 * Loads a YAML policy bundle and evaluates (IntentEnvelope, ProposedAction)
 * pairs against its rules, returning a GovernanceDecision.
 *
 * Policy is data: rules are declarative, versioned, and promotable without a
 * code deploy. Only a strict allow-list of predicate keys is supported — a
 * typo'd key fails validation at load, never silently matches everything.
 *
 * Semantics: first matching rule wins; no match is default-deny. The
 * SafetyNet runs independently and vetoes regardless of this result.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Severity } from '../support-voice-agent/types.js';
import type { IntentEnvelope } from '../event-log/types.js';
import type { GovernanceDecision, ProposedAction } from './decision.js';

const PredicateSchema = z
  .object({
    /** Envelope intent kind must equal. */
    intent_kind: z.string().optional(),
    /** Envelope intent subKind must equal (requires intent_kind to match too). */
    intent_subKind: z.string().optional(),
    /** Proposed tool must be in this set. */
    tools_in: z.array(z.string()).optional(),
    /** Envelope severity must be in this set. */
    severity_in: z.array(z.string()).optional(),
    /** True → at least one referenced runbook id looks destructive. */
    runbook_destructive: z.boolean().optional(),
    /** Regex tested against the serialized action args (candidate output). */
    output_matches_regex: z.string().optional(),
  })
  .strict();

const RuleSchema = z
  .object({
    id: z.string().min(1),
    when: PredicateSchema.default({}),
    effect: z.enum(['allow', 'deny', 'require_approval', 'transform']),
    reason: z.string().optional(),
    approver_role: z.string().optional(),
    approver_count: z.number().int().positive().optional(),
    timeout_seconds: z.number().int().positive().optional(),
    on_timeout: z.enum(['allow', 'deny']).optional(),
    output_matches_regex: z.string().optional(),
  })
  .strict();

const BundleSchema = z.object({
  rules: z.array(RuleSchema).default([]),
});

export type PolicyRule = z.infer<typeof RuleSchema>;

export interface PolicyEngineOptions {
  /** The raw YAML bundle text. */
  yaml: string;
}

export class PolicyEngine {
  private readonly rules: readonly PolicyRule[];

  constructor(opts: PolicyEngineOptions) {
    const parsed: unknown = parseYaml(opts.yaml);
    const bundle = BundleSchema.parse(parsed);
    this.rules = bundle.rules;
  }

  evaluate(envelope: IntentEnvelope, action: ProposedAction): GovernanceDecision {
    const candidateOutput = JSON.stringify(action.args ?? {});
    for (const rule of this.rules) {
      if (!this.matches(rule, envelope, action, candidateOutput)) continue;
      return {
        effect: rule.effect,
        reason: rule.reason ?? `matched rule ${rule.id}`,
        policyIds: [rule.id],
        ...(rule.approver_role !== undefined && { approverRole: rule.approver_role }),
        ...(rule.approver_count !== undefined && { approverCount: rule.approver_count }),
        ...(rule.timeout_seconds !== undefined && { timeoutSeconds: rule.timeout_seconds }),
        ...(rule.on_timeout !== undefined && { onTimeout: rule.on_timeout }),
      };
    }
    return { effect: 'deny', reason: 'no matching policy (default-deny)', policyIds: [] };
  }

  private matches(rule: PolicyRule, env: IntentEnvelope, action: ProposedAction, candidateOutput: string): boolean {
    const w = rule.when;

    if (w.intent_kind !== undefined && w.intent_kind !== env.intent.kind) return false;

    if (w.intent_subKind !== undefined) {
      if (!('subKind' in env.intent) || env.intent.subKind !== w.intent_subKind) return false;
    }

    if (w.tools_in !== undefined && !w.tools_in.includes(action.tool)) return false;

    if (w.severity_in !== undefined) {
      const severity: Severity | undefined = env.entities.severity;
      if (severity === undefined || !w.severity_in.includes(severity)) return false;
    }

    if (w.runbook_destructive === true && !this.destructiveRunbook(env)) return false;

    if (w.output_matches_regex !== undefined || rule.output_matches_regex !== undefined) {
      const pattern = rule.output_matches_regex ?? w.output_matches_regex;
      if (pattern !== undefined) {
        try {
          if (!new RegExp(pattern).test(candidateOutput)) return false;
        } catch {
          return false; // invalid regex cannot match anything
        }
      }
    }

    return true;
  }

  /** A runbook is destructive when one of the envelope's runbook ids carries
   *  the explicit prod/all scope markers used by today's runbook catalog. */
  private destructiveRunbook(env: IntentEnvelope): boolean {
    return (env.entities.runbookIds ?? []).some((id) => /\b(all|prod(uction)?)\b/i.test(id));
  }
}

/**
 * SafetyNet facade (spec §5): always-on, independent of policy data.
 * Lives in code, not YAML — changes go through normal PR review.
 *
 * runAll() evaluates every check; if ANY check vetoes, the action is vetoed.
 * The returned `unconditionalSafetyNetCheck: true` flag proves the net ran,
 * so downstream code can require it on every Decision.
 */
import type { LoopContext } from './loop-detector.js';
import { Rbac, type SpeakerRole, type SpeakerRegistry } from './rbac.js';
import { Injection } from './injection.js';
import { LoopDetector } from './loop-detector.js';
import { CostCap } from './cost-cap.js';
import { OutputFilters } from './output-filters.js';

export type { VetoResult } from './injection.js';
export type { SpeakerRole, SpeakerRegistry, RbacOptions, RbacDecision } from './rbac.js';
export type { LoopContext } from './loop-detector.js';
export type { CostCapOptions } from './cost-cap.js';

export interface SafetyNetOptions {
  speakers?: SpeakerRegistry;
  approverRoles?: SpeakerRole[];
  tokenCapPerRequest?: number;
  /** Max identical (tool, args) calls per correlation before the loop veto. */
  maxIdenticalToolCalls?: number;
}

export interface RunAllInput {
  correlationId: string;
  speakerId: string;
  tool: string;
  args: Record<string, unknown>;
  tokens: { prompt: number; completion: number };
  /** Output the agent is about to emit/return — filtered, never trusted. */
  candidateOutput: string;
}

export interface RunAllResult {
  vetoed: boolean;
  reasons: string[];
  unconditionalSafetyNetCheck: true;
}

export class SafetyNet {
  readonly rbac: Rbac;
  readonly injection: Injection;
  readonly loop: LoopDetector;
  readonly costCap: CostCap;
  readonly outputFilters: OutputFilters;

  constructor(opts: SafetyNetOptions = {}) {
    this.rbac = new Rbac({ speakers: opts.speakers, approverRoles: opts.approverRoles });
    this.injection = new Injection();
    this.loop = new LoopDetector(opts.maxIdenticalToolCalls);
    this.costCap = new CostCap({ tokenCapPerRequest: opts.tokenCapPerRequest });
    this.outputFilters = new OutputFilters();
  }

  runAll(input: RunAllInput): RunAllResult {
    const reasons: string[] = [];
    const ctx: LoopContext = { correlationId: input.correlationId };

    const rb = this.rbac.check(input.speakerId, input.tool);
    if (!rb.allowed) reasons.push(`rbac: ${rb.reason}`);

    const inj = this.injection.check(input.candidateOutput);
    if (inj.vetoed) reasons.push(`injection: ${inj.reason}`);

    const loop = this.loop.check(ctx, input.tool, input.args);
    if (loop.vetoed) reasons.push(`loop: ${loop.reason}`);

    const cost = this.costCap.check(input.tokens);
    if (cost.vetoed) reasons.push(`cost: ${cost.reason}`);

    const out = this.outputFilters.check(input.candidateOutput);
    if (out.vetoed) reasons.push(`output: ${out.reason}`);

    return { vetoed: reasons.length > 0, reasons, unconditionalSafetyNetCheck: true };
  }
}

/**
 * Cost cap: vetoes when the token spend of one request exceeds the cap.
 * Prevents runaway LLM loops from burning budget; complements the loop
 * detector, which catches repetition but not expensive non-repetitive calls.
 */
import type { VetoResult } from './injection.js';

export interface CostCapOptions {
  tokenCapPerRequest?: number;
}

const DEFAULT_TOKEN_CAP = 50_000;

export class CostCap {
  private readonly cap: number;

  constructor(opts: CostCapOptions = {}) {
    this.cap = opts.tokenCapPerRequest ?? DEFAULT_TOKEN_CAP;
  }

  check(tokens: { prompt: number; completion: number }): VetoResult {
    const total = tokens.prompt + tokens.completion;
    if (total > this.cap) {
      return { vetoed: true, reason: `token cap exceeded: ${total} > ${this.cap}` };
    }
    return { vetoed: false, reason: '' };
  }
}

/**
 * LlmAgent base (spec §6.3): a focused system prompt + Zod-validated JSON
 * output. Degradation is honest and consistent with the Understanding layer:
 *  - unwired LLM or invalid output → deterministic fallback (marked)
 *  - provider-side failure (429-saturated ladder exhaustion, open breaker,
 *    network fault) → deterministic fallback too, with `degradedReason`
 *    carrying the real LlmError code — a saturated provider costs planning
 *    fidelity, not availability. Non-LlmError bugs still propagate.
 *
 * Every result records whether it came from the LLM or the fallback so the
 * caller (and tests) can assert which brain produced the decision.
 */
import { z } from 'zod';
import { LlmError } from '../../support-voice-agent/tools/llm.js';
import type { LlmClient } from '../../support-voice-agent/tools/llm.js';

export interface AgentRunInput {
  envelope: import('../../understanding/context-assembler.js').ContextBundle['envelope'];
  episodes: import('../../understanding/context-assembler.js').ContextBundle['episodes'];
  recent: import('../../understanding/context-assembler.js').ContextBundle['recent'];
}

export interface AgentRunOutput<T> {
  decision: T;
  source: 'llm' | 'fallback';
  /** Set only when the LLM was wired but a provider-side failure downgraded
   *  this run to the deterministic fallback (see class doc). Lets callers
   *  distinguish "no brain configured" from "brain unreachable" and lets
   *  tests prove why fidelity dropped. Absent for unwired/invalid-output
   *  fallbacks. */
  degradedReason?: 'unwired' | 'network' | 'http_error' | 'malformed' | 'circuit_open';
  /** Token usage reported by the provider, when it returns one. Absent on
   *  fallback paths and for providers that omit usage — callers must treat
   *  absence as "no data", never as zero-cost confirmation. */
  usage?: { prompt: number; completion: number };
}

export abstract class LlmAgent<T extends z.ZodType> {
  protected abstract schema: T;
  protected abstract systemPrompt: string;

  constructor(protected readonly opts: { llm: LlmClient }) {}

  protected get llm(): LlmClient {
    return this.opts.llm;
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput<z.output<T>>> {
    if (!this.llm.isWired()) {
      return { decision: this.fallback(input), source: 'fallback' };
    }
    let raw: string;
    let usage: { prompt: number; completion: number } | undefined;
    try {
      ({ raw, usage } = await this.callLlm(input));
    } catch (e) {
      if (e instanceof LlmError) {
        // Same degradation ladder as the intent classifier: the reason is
        // surfaced on the result, never silent. Interface bugs propagate.
        return { decision: this.fallback(input), source: 'fallback', degradedReason: e.code };
      }
      throw e;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { decision: this.fallback(input), source: 'fallback', ...(usage ? { usage } : {}) };
    }
    const parsed = this.schema.safeParse(parsedJson);
    if (!parsed.success) {
      return { decision: this.fallback(input), source: 'fallback', ...(usage ? { usage } : {}) };
    }
    return { decision: parsed.data, source: 'llm', ...(usage ? { usage } : {}) };
  }

  /** Deterministic decision used when the LLM is unavailable or invalid. */
  protected abstract fallback(input: AgentRunInput): z.output<T>;

  private async callLlm(input: AgentRunInput): Promise<{ raw: string; usage?: { prompt: number; completion: number } }> {
    const r = await this.llm.complete({
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: JSON.stringify(input) },
      ],
      tools: [],
      tool_choice: 'none',
      temperature: 0,
      max_tokens: 4000,
    });
    const usage = r.usage
      ? { prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens }
      : undefined;
    return { raw: String(r.choices[0]?.message?.content ?? ''), usage };
  }
}

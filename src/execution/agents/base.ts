/**
 * LlmAgent base (spec §6.3): a focused system prompt + Zod-validated JSON
 * output. Degradation is honest and consistent with the Understanding layer:
 *  - unwired LLM or invalid output → deterministic fallback (marked)
 *  - transport/network failures → propagate (never silently degrade)
 *
 * Every result records whether it came from the LLM or the fallback so the
 * caller (and tests) can assert which brain produced the decision.
 */
import { z } from 'zod';
import type { LlmClient } from '../../support-voice-agent/tools/llm.js';

export interface AgentRunInput {
  envelope: import('../../understanding/context-assembler.js').ContextBundle['envelope'];
  episodes: import('../../understanding/context-assembler.js').ContextBundle['episodes'];
  recent: import('../../understanding/context-assembler.js').ContextBundle['recent'];
}

export interface AgentRunOutput<T> {
  decision: T;
  source: 'llm' | 'fallback';
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
    const raw = await this.callLlm(input);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { decision: this.fallback(input), source: 'fallback' };
    }
    const parsed = this.schema.safeParse(parsedJson);
    if (!parsed.success) {
      return { decision: this.fallback(input), source: 'fallback' };
    }
    return { decision: parsed.data, source: 'llm' };
  }

  /** Deterministic decision used when the LLM is unavailable or invalid. */
  protected abstract fallback(input: AgentRunInput): z.output<T>;

  private async callLlm(input: AgentRunInput): Promise<string> {
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
    return String(r.choices[0]?.message?.content ?? '');
  }
}

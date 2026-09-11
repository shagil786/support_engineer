/**
 * ReviewerAgent — the LLM critic over the tool-call trace. Fails safe:
 * without an LLM the verdict is 'pass' (the deterministic verifier already
 * ran), and invalid output degrades to 'pass' with a note.
 */
import { z } from 'zod';
import { LlmAgent, type AgentRunInput } from './base.js';

const Schema = z.object({
  verdict: z.enum(['pass', 'fail', 'reask']),
  feedback: z.string().default(''),
});

export type ReviewerDecision = z.output<typeof Schema>;

export class ReviewerAgent extends LlmAgent<typeof Schema> {
  protected schema = Schema;
  protected systemPrompt =
    'You are the ReviewerAgent. Read the tool-call trace and outputs, then judge whether the request was handled correctly. ' +
    'Output ONLY JSON: { "verdict": "pass"|"fail"|"reask", "feedback": string }.\n' +
    'Verdict semantics: "fail" = the work is correctable — feedback MUST name the concrete fix (evidence to gather, step to redo); ' +
    'a fail triggers a bounded re-investigation. "pass" = the request was handled correctly. ' +
    '"reask" = the request cannot be resolved from the trace without a human — name the question; nothing executes.';

  protected fallback(_input: AgentRunInput): ReviewerDecision {
    return { verdict: 'pass', feedback: 'reviewer fallback (no LLM output)' };
  }
}

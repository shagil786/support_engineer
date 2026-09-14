/**
 * Drift guard — the LLM-visible tool definitions (TOOL_SCHEMAS, what the
 * model conditions on) must agree with the executor's zod schemas (what the
 * tool-runner enforces). Found live with Groq/Qwen: TOOL_SCHEMAS declared
 * `kinds: { type: 'array' }` with no enum, so the model invented `alert`,
 * the executor's strict enum rejected it, and the post-run verification of
 * an APPROVED destructive runbook failed. The model can only emit valid
 * args if the constraints are visible in its tool definition.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../src/support-voice-agent/tools/types';
import { QueryEvidenceSchema } from '../../src/execution/tools/schemas';

describe('LLM-visible tool schemas match the executor zod schemas', () => {
  it('query_evidence kinds enum mirrors QueryEvidenceSchema exactly', () => {
    const params = TOOL_SCHEMAS.query_evidence?.parameters as unknown as {
      properties?: { kinds?: { items?: { enum?: readonly string[] } } };
    };
    const visibleEnum = params?.properties?.kinds?.items?.enum;
    expect(visibleEnum, 'TOOL_SCHEMAS.query_evidence must declare an items.enum for kinds').toBeDefined();
    const zodKinds = QueryEvidenceSchema.shape.kinds.unwrap().element.options;
    expect([...(visibleEnum ?? [])]).toEqual([...zodKinds]);
  });
});

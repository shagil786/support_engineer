/** LLM Orchestrator — coexists with deterministic etiquette brain. */
import { LlmError, schemasToOpenAiTools } from './llm.js';
import type { LlmClient, LlmMessage, LlmChatRequest, LlmChatResponse } from './llm.js';
import type { ToolName, ToolCall, ToolResult, ToolDependencies } from './types.js';
import { handlers } from './handlers.js';

export interface OrchestratorConfig {
  llm?: LlmClient;
  deps: ToolDependencies;
  /** System prompt describing the agent's role and available tools. */
  systemPrompt: string;
  /** Maximum tool-call rounds before giving up. */
  maxRounds?: number;
  /** Callback when the orchestrator wants to emit speech (for TTS). */
  onSpeech?: (text: string) => void;
}

export interface OrchestratorResult {
  speech: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  fallbackToDeterministic: boolean;
  error?: string;
}

export class LlmOrchestrator {
  private readonly llm: LlmClient | undefined;
  private readonly deps: ToolDependencies;
  private readonly systemPrompt: string;
  private readonly maxRounds: number;
  private readonly onSpeech?: (text: string) => void;

  constructor(config: OrchestratorConfig) {
    this.llm = config.llm;
    this.deps = config.deps;
    this.systemPrompt = config.systemPrompt;
    this.maxRounds = config.maxRounds ?? 3;
    this.onSpeech = config.onSpeech;
  }

  isWired(): boolean {
    return this.llm !== undefined && this.llm.isWired();
  }

  /** Build the message history for the LLM from the meeting context. */
  private buildMessages(
    utterance: string,
    recentHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  ): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...recentHistory.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: utterance },
    ];
    return messages;
  }

  /** Execute a single tool call against the registry. */
  private async executeToolCall(call: ToolCall): Promise<ToolResult> {
    const handler = handlers[call.name as ToolName];
    if (!handler) {
      return { ok: false, error: `Unknown tool: ${call.name}` };
    }
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      return await handler(args, this.deps);
    } catch (e) {
      return { ok: false, error: 'Tool handler threw', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Main entry: process one user utterance through the LLM + tools loop. */
  async process(utterance: string, history: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<OrchestratorResult> {
    const llm = this.llm;
    if (!llm || !llm.isWired()) {
      return {
        speech: '',
        toolCalls: [],
        toolResults: [],
        fallbackToDeterministic: true,
        error: 'LLM not configured',
      };
    }

    const tools = schemasToOpenAiTools();
    const messages = this.buildMessages(utterance, history);
    const allToolCalls: ToolCall[] = [];
    const allToolResults: ToolResult[] = [];

    for (let round = 0; round < this.maxRounds; round++) {
      const request: LlmChatRequest = {
        messages,
        tools,
        tool_choice: 'auto',
      };

      let response: LlmChatResponse;
      try {
        response = await llm.complete(request);
      } catch (e) {
        if (e instanceof LlmError && e.code === 'unwired') {
          return { speech: '', toolCalls: [], toolResults: [], fallbackToDeterministic: true, error: 'LLM unwired' };
        }
        return { speech: '', toolCalls: allToolCalls, toolResults: allToolResults, fallbackToDeterministic: true, error: `LLM error: ${e instanceof Error ? e.message : String(e)}` };
      }

      const choice = response.choices[0];
      if (!choice) {
        throw new LlmError('malformed', 'LLM response choice missing');
      }
      const msg = choice.message;

      // Assistant text (pre-tool) — could be empty if it only wants to call tools
      if (msg.content) {
        messages.push({ role: 'assistant', content: msg.content });
      }

      // Tool calls
      if (msg.tool_calls?.length) {
        const toolCalls: ToolCall[] = msg.tool_calls.map((tc) => ({
          name: tc.function.name as ToolName,
          arguments: tc.function.arguments,
          id: tc.id,
        }));
        allToolCalls.push(...toolCalls);

        // Execute all tool calls in parallel
        const results = await Promise.all(toolCalls.map((tc) => this.executeToolCall(tc)));
        allToolResults.push(...results);

        // Feed results back as tool messages
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const result = results[i];
          if (!tc || !result) continue;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.name,
            content: JSON.stringify(result),
          });
        }

        // If the model chose to stop after tool calls, we'll loop again
        if (choice.finish_reason !== 'tool_calls') {
          break;
        }
      } else {
        // No tool calls — final answer
        if (msg.content) {
          this.onSpeech?.(msg.content);
          return {
            speech: msg.content,
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            fallbackToDeterministic: false,
          };
        }
        // No content and no tools — empty response, break
        break;
      }
    }

    // Max rounds reached or no content — return what we have
    const lastMsg = messages[messages.length - 1];
    const speech = lastMsg && lastMsg.role === 'assistant' && typeof lastMsg.content === 'string' ? lastMsg.content : '';
    if (speech) this.onSpeech?.(speech);
    return { speech, toolCalls: allToolCalls, toolResults: allToolResults, fallbackToDeterministic: false };
  }
}

/** Default system prompt — aligns with the product spec. */
export const DEFAULT_SYSTEM_PROMPT = `You are a Support Engineer Voice Agent in a live meeting (standup, war room, client call).
You have access to tools for Jira, logs, runbooks, and team communication.

MEETING ETIQUETTE (you do NOT handle this — the deterministic brain handles wake word, mute, barge-in):
- You only speak when the deterministic layer routes to you (response mode: wake word, direct questions, vague complaints needing clarification).
- Keep responses under 20 words unless reporting logs/critical data.
- Wait for a ~1.5s pause before speaking (the host enforces this).

TOOL USAGE:
- jira_create_issue: file bugs/tasks from verbal feedback. Use priority as object {"name": "High"} format.
- query_logs: when asked for log analysis or checking server health. Default last 30 minutes.
- execute_runbook_script: ONLY after human confirms. Destructive actions need explicit approval.
- invoke_human_on_slack: when you need human verification/approval. Page the right person.
- meeting_interrupt: for P1/P0 alerts — the deterministic layer usually handles barge-in, but you may use this for proactive critical alerts.

RESPONSE STYLE:
- Natural, concise, engineer-to-engineer. "Got it, creating BUG-123 now." "Found the error in logs — null pointer in payment service."
- If unwired for a backend, say so: "I'm not connected to Jira right now, so I can't file that."
- Never guess. If unsure, use invoke_human_on_slack to verify.`;
